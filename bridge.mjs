/**
 * PI2X — QQ 智能助手主入口
 *
 * 启动流程：
 *  1. 同步 NapCat 的 OneBot11 配置（端口/token 与 config.json 一致）
 *  2. 拉起 NapCat（若未运行）；未登录 QQ 时提示扫码
 *  3. 等待 OneBot WS 就绪，连接 QQBridge
 *  4. 消息路由 → pi AgentSession（隔离环境）→ 回复分段发回 QQ
 *
 * 用法：node bridge.mjs
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureOnebotConfig, start, waitForReady, stop, isRunning } from "./lib/napcat.mjs";
import { QQBridge } from "./lib/qqbridge.mjs";
import { createPiAgent } from "./lib/piagent.mjs";
import { createLogger } from "./lib/log.mjs";
import { ROOT, STATE_DIR, config } from "./lib/config.mjs";
import { touchHeartbeat } from "./lib/mode.mjs";

/* 各子系统日志器（scope 决定日志标签，取代原先手写的 "[xxx] " 前缀） */
const logBoot = createLogger("boot");
const logImg = createLogger("img");
const logFile = createLogger("file");
const logGroup = createLogger("群历史");
const logDedup = createLogger("dedup");
const logMerge = createLogger("merge");
const logSent = createLogger("sent");
const logRecv = createLogger("recv");
const logReply = createLogger("reply");
const logErr = createLogger("error");
const logShutdown = createLogger("shutdown");

// ---------- 图片处理辅助 ----------
/**
 * 展开合并转发：把 `[转发 id:xxx]` 替换成可读的正文块。
 *
 * 【为什么要它】OneBot11 的合并转发只给一个 id，正文得再调一次 get_forward_msg。
 * 改动前 extractText 把整段压成 `[forward]`，上层既不知道有转发、也拿不到 id，
 * 内容永久丢失（连记账都没有）。现在产出 `[转发 id:xxx]` 作为取件凭据，这里负责取回。
 *
 * 失败处理：拉不到（消息过期 / 权限不足 / 网络抖动）时不静默丢弃，
 * 而是替换成一句说明，让模型知道「这里本来有内容但读不到」，避免它编造。
 *
 * @param {import("./lib/qqbridge.mjs").QQBridge} bridge
 * @param {unknown} message 原始消息段数组
 * @param {string} rawText extractText 的结果（含 `[转发 id:...]`）
 * @returns {Promise<string>} 替换后的文本
 */
async function expandForward(bridge, message, rawText) {
  const seg = (Array.isArray(message) ? message : []).find((s) => s.type === "forward" || s.type === "json" || s.type === "xml");
  const idMatch = /\[转发 id:([^\]]+)\]/.exec(rawText);
  const fid = idMatch?.[1] ?? seg?.data?.id ?? seg?.data?.message_id ?? "";
  if (!fid) return rawText.replace(/\[转发[^\]]*\]/, "〔转发消息（无法识别转发 id）〕");
  try {
    const res = await bridge.getForwardMsg(fid);
    const items = QQBridge.parseForwardMessages(res);
    const block = QQBridge.renderForward(items);
    logMerge.info(`展开合并转发 id=${fid} · ${items.length} 条`);
    return rawText.replace(/\[转发[^\]]*\]/, block);
  } catch (e) {
    logMerge.warn(`展开合并转发失败 id=${fid}: ${e?.message}`);
    return rawText.replace(/\[转发[^\]]*\]/, "〔转发消息（拉取失败，可能已过期或无权限）〕");
  }
}

const MAX_IMAGE_BYTES = 6 * 1024 * 1024; // 单图上限 6MB（原始）

/** magic bytes 探测图片格式 */
function detectMime(buf) {
  if (!buf || buf.length < 12) return null;
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return "image/png";
  if (buf[0] === 0xff && buf[1] === 0xd8) return "image/jpeg";
  if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46) return "image/gif";
  if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
      buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50) return "image/webp";
  if (buf[0] === 0x42 && buf[1] === 0x4d) return "image/bmp";
  return null;
}

/** 收集消息中的图片 → SDK ImageContent[] {type:'image', data(base64), mimeType} */
async function collectImages(ev, bridge) {
  const parts = QQBridge.extractImages(ev.message);
  if (!parts.length) return [];
  const out = [];
  for (const img of parts) {
    try {
      let buf = null;
      let name = "";
      // 1) 优先 get_image 拿本地缓存路径
      if (img.file) {
        try {
          const g = await bridge.api("get_image", { file: img.file }, 15000);
          const p = g?.file || g?.path;
          if (p && fs.existsSync(p) && fs.statSync(p).size <= MAX_IMAGE_BYTES) {
            buf = fs.readFileSync(p);
            name = p;
          }
        } catch { /* 继续尝试 URL */ }
      }
      // 2) URL 下载兑底
      if (!buf && img.url) {
        const resp = await fetch(img.url);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          if (ab.byteLength <= MAX_IMAGE_BYTES) { buf = Buffer.from(ab); name = img.url; }
        }
      }
      if (buf) {
        const mimeType = detectMime(buf) ?? "image/png";
        out.push({ type: "image", data: buf.toString("base64"), mimeType });
        logImg.info(`已收集图片 ${name.slice(-40)} (${buf.length} 字节, ${mimeType})`);
      } else {
        logImg.warn("图片获取失败（超大小或无路径/URL）");
      }
    } catch (e) {
      logImg.warn(`图片获取失败: ${e?.message}`);
    }
  }
  return out;
}

// ---------- 文件接收辅助（非图片文件 → 落地到 workspace/downloads/） ----------
const DOWNLOAD_DIR = path.join(ROOT, "workspace", "downloads");
const MAX_FILE_BYTES = 60 * 1024 * 1024; // 单文件上限 60MB

/** 收集消息中的文件段 → 落地本地，返回 [{name, path, size, url}] */
async function collectFiles(ev, bridge) {
  const parts = QQBridge.extractFiles(ev.message);
  if (!parts.length) return [];
  fs.mkdirSync(DOWNLOAD_DIR, { recursive: true });
  const out = [];
  for (const f of parts) {
    try {
      let buf = null;
      let name = f.name || "file";
      // 1) get_file 拿本地缓存路径（file_id）
      const fileId = f.file || f.id;
      if (fileId) {
        try {
          const g = await bridge.api("get_file", { file: fileId });
          const p = g?.file || g?.path;
          if (p && fs.existsSync(p) && fs.statSync(p).size <= MAX_FILE_BYTES) {
            buf = fs.readFileSync(p);
            if (!name || name === "file") name = path.basename(p) || name;
          }
        } catch { /* 继续 URL */ }
      }
      // 2) URL 下载兑底
      if (!buf && f.url) {
        const resp = await fetch(f.url);
        if (resp.ok) {
          const ab = await resp.arrayBuffer();
          if (ab.byteLength <= MAX_FILE_BYTES) { buf = Buffer.from(ab); }
        }
      }
      if (buf) {
        // 清理文件名，落盘
        name = path.basename(String(name)).replace(/[\/:*?"<>|]/g, "_") || "file";
        const dest = path.join(DOWNLOAD_DIR, name);
        fs.writeFileSync(dest, buf);
        out.push({ name, path: dest, size: buf.length, url: f.url || "" });
        logFile.info(`已接收文件 ${name} (${buf.length} 字节) → ${dest}`);
      } else {
        logFile.warn(`文件获取失败：${name || fileId}`);
      }
    } catch (e) {
      logFile.warn(`文件获取失败: ${e?.message}`);
    }
  }
  return out;
}

// ---------- 1. NapCat 配置同步 ----------
ensureOnebotConfig();

// ---------- 2. 启动 NapCat ----------
if (!(await isRunning())) {
  logBoot.info("启动 NapCat...");
  await start();
}
const ready = await waitForReady(60000);
if (!ready) {
  logBoot.warn("OneBot WS 未就绪 —— 首次运行需要扫码登录 QQ：");
  logBoot.warn("  二维码: D:\\PI2X\\napcat\\napcat\\cache\\qrcode.png");
  logBoot.warn("  扫码后本程序会继续检测连接...");
}
const readyFinal = await waitForReady(300000);
if (!readyFinal) {
  logBoot.error("等待 QQ 登录超时，退出。扫码登录后重新运行。");
  stop();
  process.exit(1);
}
logBoot.info("OneBot WS 已就绪");

// ---------- 3. 连接 QQ ----------
const nb = config.napcat.onebot;
const bridge = new QQBridge({ host: nb.wsHost, port: nb.wsPort, token: nb.token });
await bridge.connect();

// ---------- 4. pi agent ----------
const pi = createPiAgent({ bridge });
await pi.init();
logBoot.info("pi agent 就绪，PI2X 开始工作");

// ---------- 4.5 心跳 ----------
// 供看门狗（scripts/watchdog.mjs，由 cron 调用）判断「正常模式是否还活着」。
// 除了进程存在与否，心跳还能识别「进程活着但卡死」——那才是最难发现的一类故障。
// 心跳写不出去也不该拖垮主流程（尽力而为），所以整体 try/catch。
{
  const intervalMs = Number(config.lifecycle?.heartbeatIntervalMs ?? 60000);
  const beat = () => {
    try {
      touchHeartbeat(STATE_DIR);
    } catch (e) {
      logBoot.warn(`心跳写入失败: ${e?.message}`);
    }
  };
  beat();
  const hb = setInterval(beat, intervalMs);
  hb.unref?.();
  process.on("SIGTERM", () => clearInterval(hb));
  logBoot.info(`心跳已启动（每 ${Math.round(intervalMs / 1000)} 秒）`);
}

// ---------- 5. 消息路由 ----------
const perm = config.permissions ?? {};
const allowedUsers = (perm.allowedUsers ?? []).map(String);
const allowedGroups = (perm.allowedGroups ?? []).map(String);
const groupMode = perm.groupReplyMode ?? "mention"; // mention: 仅 @ 回复; all: 全部回复
/** 拉取某群最近聊天记录，格式化为模型可读的上下文块（失败返回空串）
 * staleMin：若最新一条消息距今超过该分钟数，返回空（表示群已冷场，不再冒泡） */
async function fetchRecentGroupCtx(gid, selfId, limit = 12, staleMin = 0) {
  try {
    const r = await bridge.getGroupMsgHistory(Number(gid), 15);
    const msgs = r?.messages ?? r?.data ?? (Array.isArray(r) ? r : []);
    if (!msgs.length) return "";
    // 冷场判断：最新一条消息距今超过 staleMin 分钟 → 视为已冷场（不冒泡）
    if (staleMin > 0) {
      const newest = msgs[msgs.length - 1]?.time ?? 0;
      if (newest && (Date.now() / 1000 - newest) > staleMin * 60) return "";
    }
    const lines = msgs.map((m) => {
      const nm = m.sender?.card || m.sender?.nickname || String(m.user_id);
      const t = new Date((m.time ?? 0) * 1000).toLocaleString("zh-CN", { hour12: false });
      const txt = QQBridge.extractText(m.message);
      const who = String(m.user_id) === String(selfId) ? "我" : nm;
      return `[${t}] ${who}: ${txt || "（非文本）"}`;
    });
    return "\n\n【该群最近聊天记录（供你判断上下文）】\n" + lines.slice(-limit).join("\n");
  } catch (e) {
    logGroup.warn(`拉取失败: ${e?.message}`);
    return "";
  }
}

function allowed(chatType, id) {
  if (chatType === "user") return allowedUsers.length === 0 || allowedUsers.includes(String(id));
  return allowedGroups.length === 0 || allowedGroups.includes(String(id));
}

// ---------- 消息去重（同一 message_id 只处理一次） ----------
const seenMessages = new Map(); // message_id -> lastSeen
const DEDUP_WINDOW_MS = 60_000;

function isDuplicate(messageId) {
  if (!messageId) return false;
  const key = String(messageId);
  const now = Date.now();
  const last = seenMessages.get(key);
  if (last !== undefined && now - last < DEDUP_WINDOW_MS) {
    logDedup.info(`跳过重复消息 ${key}`);
    return true;
  }
  seenMessages.set(key, now);
  if (seenMessages.size > 1000) {
    for (const [k, t] of seenMessages) if (now - t > DEDUP_WINDOW_MS) seenMessages.delete(k);
  }
  return false;
}

function splitReply(text, maxLen) {
  // 按 \n\n（空行/段落）分割：每个段落作为独立一条消息；段落过长时再按字数切。
  const paras = String(text).split(/\n\s*\n/).map((s) => s.trim()).filter(Boolean);
  const parts = [];
  for (const p of paras) {
    // 段落不超长 → 整段作为一条
    if (p.length <= maxLen) {
      parts.push(p);
      continue;
    }
    // 段落超长 → 按字数切分（保留段落内换行；无换行的长段也按字数硬切）
    let cur = "";
    const lines = p.split(/\r?\n/);
    for (const line of lines) {
      // 单行超长：直接按 maxLen 切成多块
      if (line.length >= maxLen) {
        if (cur) { parts.push(cur.trim()); cur = ""; }
        for (let i = 0; i < line.length; i += maxLen) { parts.push(line.slice(i, i + maxLen)); }
        continue;
      }
      if ((cur + "\n" + line).length > maxLen && cur) {
        parts.push(cur.trim());
        cur = line;
      } else {
        cur = cur ? cur + "\n" + line : line;
      }
    }
    if (cur.trim()) parts.push(cur.trim());
  }
  return parts.length ? parts : [""];
}

// ---------- 并发消息合并缓冲（同一 chatKey 窗口内的连续消息合并为一条回答） ----------
const MERGE_WINDOW_MS = 5000; // 窗口：5s 内连发合并
const mergeBuf = new Map();   // chatKey -> { texts:[], images:[], timer, targetId, chatType, selfId, userName, userId, trigger, triggerType }
// 注：trigger(message_id) 仅作事件溯源记录；bot 回复**不引用**原消息（发送时不再传 message_id）。

function mergeFlush(chatKey) {
  const b = mergeBuf.get(chatKey);
  if (!b) return;
  clearTimeout(b.timer);
  mergeBuf.delete(chatKey);
  // 合并文本：多条消息用换行分隔，并标注这是连续消息
  const joined = b.texts.map((t, i) => (b.texts.length > 1 ? `〔第${i + 1}条〕${t}` : t)).join("\n");
  logMerge.info(`${chatKey} 合并 ${b.texts.length} 条 → 提交`);
  _processNormal({
    chatKey,
    text: joined || b.texts[0] || "",
    chatType: b.chatType,
    targetId: b.targetId,
    selfId: b.selfId,
    userName: b.userName,
    userId: b.userId,
    images: b.images,
    trigger: b.trigger,
    skipMemory: b.skipMemory,
    triggerType: b.triggerType ?? "@唤醒",
  });
}

// 进合并缓冲：窗口内追加，窗口结束或到达时触发合并
function mergeEnqueue({ chatKey, text, chatType, targetId, selfId, userName, userId, images, trigger, skipMemory, triggerType }) {
  let b = mergeBuf.get(chatKey);
  if (!b) {
    b = { texts: [], images: [], chatType, targetId, selfId, userName, userId, trigger: null, skipMemory: false };
    b.triggerType = b.triggerType ?? null;
    mergeBuf.set(chatKey, b);
  }
  b.texts.push(text);
  if (images?.length) b.images.push(...images);
  b.trigger = trigger ?? b.trigger;
  if (triggerType) b.triggerType = b.triggerType ?? triggerType;  // 记录唤醒方式（@唤醒/名称唤醒），仅用于日志溯源
  if (skipMemory) b.skipMemory = true;
  // 窗口内可达：重新计时（只要还有后续消息就等），否则到 5s 触发
  clearTimeout(b.timer);
  b.timer = setTimeout(() => mergeFlush(chatKey), MERGE_WINDOW_MS);
}

// 立即处理一条普通消息（不走合并）；含命令路由判断
async function _processNormal({ chatKey, text, chatType, targetId, selfId, userName, userId, images, trigger, skipMemory, triggerType }) {
  const message_type = chatType === "group" ? "group" : "user";
  const _id = chatType === "group" ? Number(targetId) : Number(userId);
  const reply = await pi.handleMessage({
    chatKey,
    text,
    chatType,
    targetId,
    selfId,
    userName,
    userId,
    images,
    skipMemory,
  });
  const cleaned = reply.replace(/\s+$/, "");
  if (!cleaned) return;

  const maxLen = Number(config.pi.maxReplyChars) || 1500;
  const parts = splitReply(cleaned, maxLen);
  for (const part of parts.slice(0, 8)) {
    // bot 回复不引用原消息（不带 message_id）
    if (chatType === "group") await bridge.sendGroupMsg(Number(targetId), part);
    else await bridge.sendPrivateMsg(Number(userId), part);
    await new Promise((r) => setTimeout(r, 300));
  }
  logSent.info(`${chatKey}: ${cleaned.replace(/\n/g, " ").slice(0, 60)}${parts.length > 1 ? ` (+${parts.length - 1}段)` : ""}`);
}

bridge.on("event", async (ev) => {
  if (ev.post_type !== "message") return;
  if (isDuplicate(ev.message_id)) return;

  const { message_type, user_id, group_id, self_id, message, message_id } = ev;
  const rawText0 = QQBridge.extractText(message).trim();
  // 引用全文增强：reply 段带 id → get_msg 拉被引用消息全文（失败则保留段内自带预览）
  // 注：extractText 产出的标记是 [引用…]（NapCat reply 段只给 id，不含文本，必须 get_msg 拉全文）
  let rawText = rawText0;
  if (rawText0.includes("[引用")) {
    try {
      const replySeg = (Array.isArray(message) ? message : []).find((s) => s.type === "reply");
      const rid = replySeg?.data?.id;
      if (rid && rid !== 0) {
        const r = await bridge.getMsg(Number(rid));
        const tm = r?.message ?? r?.data?.message ?? r?.data;
        let full = QQBridge.extractText(tm || "");
        // 去掉被引用文本里可能夹带的 [引用…] 嵌套
        full = String(full).replace(/\[引用[^\]]*\]/g, "").trim();
        // 带出被引用者（昵称+QQ），便于模型知道“谁说的”
        const sd = r?.sender ?? r?.data?.sender ?? {};
        const who = String(sd.card || sd.nickname || "").trim();
        const uid = sd.user_id ? `(${sd.user_id})` : "";
        const head = who ? `${who}${uid}` : uid.replace(/[()]/g, "");
        if (full) {
          const shown = full.slice(0, 500) + (full.length > 500 ? "…（已截断）" : "");
          rawText = rawText0.replace(/\[引用[^\]]*\]/, `[引用${head ? " " + head : ""}: ${shown}]`);
        } else if (head) {
          rawText = rawText0.replace(/\[引用[^\]]*\]/, `[引用 ${head}（内容为空/无法读取）]`);
        }
      }
    } catch (e) {
      logReply.warn(`拉取全文失败: ${e?.message}`);
    }
  }
  // 合并转发正文增强：forward 段只有 id，正文要 get_forward_msg 另取。
  // 放在 reply 增强之后、`if (!rawText) return` 之前 —— 顺序很关键：
  // 合并转发的 extractText 产出是 `[转发 id:xxx]`（非空），所以不会被下面那道空文本闸拦掉；
  // 但若渲染失败，我们会把它降级成一个说明性占位符，避免模型看到 id 却无从理解。
  if (rawText.includes("[转发")) {
    rawText = await expandForward(bridge, message, rawText);
  }
  if (!rawText) return;

  // 群聊：响应判定 = @bot（at 段/文本 @）或喊名字（消息任意位置含 PI2X/2X/机器人）；无指向消息一律潜水
  const atSeg = QQBridge.isMentioned(message, self_id);
  const nickM = rawText.match(/^@([^\s]+)\s*/); // 文本 @xxx
  const textBot = nickM && (nickM[1] === String(self_id) || nickM[1] === "all" || nickM[1] === "PI2X" || nickM[1] === "2X");
  // 喊名字唤醒（借鉴大肥鸭：被@/喊名字才醒）
  const nameKeywords = config.permissions?.nameKeywords ?? ["pi2x", "2x", "机器人"];
  const nameRe = new RegExp("(" + nameKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");
  const hasName = nameRe.test(rawText);
  const triggerType = (atSeg || textBot) ? "@唤醒" : "名称唤醒";
  if (message_type === "group") {
    if (!atSeg && !textBot && !hasName) return; // 无任何指向 → 潜水（冒泡功能已取消）
    if (!allowed("group", group_id)) return;
  } else {
    if (!allowed("user", user_id)) return;
  }

  const chatKey = message_type === "group" ? `group:${group_id}` : `private:${user_id}`;
  const targetId = message_type === "group" ? String(group_id) : String(user_id);
  const userName = ev.sender?.card || ev.sender?.nickname || String(user_id);

  // 剥离开头的 @bot（at 段文本或 @昵称），使其后的 $ / > 可命中命令路由
  let text = textBot ? rawText.slice(nickM[0].length) : rawText;
  const isEmptyAt = textBot && !text.trim(); // 空@：只@了bot，没带文字
  // 空@不拦截，交模型自行补齐上下文；非空@才允许为空（纯表情/无意义）时跳过
  if (!isEmptyAt && !text.trim()) return;
  if (isEmptyAt) {
    // 空@：不覆盖已有内容。若当前会话缓冲里已有待处理文本，则追加轻量标记；否则补上下文。
    const busy = mergeBuf.has(chatKey);
    if (busy) {
      text = "\n（注：对方又空@了你一次，未带文字——请先处理上面那条已收到的内容；如果上面那条已经没什么可做的，就问一句 TA 想聊什么。）";
    } else {
      // 群聊空@：自动拉取该群最近聊天记录喂给模型，让它基于真实历史推断，而不是猜
      let groupCtx = "";
      if (message_type === "group") {
        groupCtx = await fetchRecentGroupCtx(group_id, self_id);
      }
      text = "（对方只@了你，没有带文字。请先依据下面的聊天记录/上下文，推断 TA 想做什么或需要什么，自然回应。" + groupCtx + "\n\n若确实无从推断，就自然地问一句 TA 想聊什么。注意：只看聊天记录，不要查记忆库。）";
    }
  } else {
    text = text.trim();
  }

  logRecv.info(`${chatKey} <${userName}>: ${text.slice(0, 80)}`);

  try {
    // 空@：不进命令路由（占位文本非命令），直接交给模型补齐上下文
    if (!isEmptyAt) {
      // 命令路由（仅 admin）：$ linux bash / > winshell / 内置命令 —— 不合并，立即处理
      const cmdReply = await pi.handleCommand(text, {
        userId: String(user_id),
        chatType: message_type === "group" ? "group" : "private",
        targetId: message_type === "group" ? String(group_id) : String(user_id),
      });
      if (cmdReply !== null) {
        for (const part of splitReply(cmdReply, 1500).slice(0, 4)) {
          if (message_type === "group") await bridge.sendGroupMsg(Number(group_id), part);
          else await bridge.sendPrivateMsg(Number(user_id), part);
        }
        return;
      }
    }

    const images = await collectImages(ev, bridge);
    const files = await collectFiles(ev, bridge);
    // 若收到文件，把落地路径告知 AI（文件消息不合并，立即处理）
    if (files.length) {
      const fileNote = files.map((f) => `
[已收到文件] 文件名: ${f.name} · 大小: ${f.size} 字节 · 服务器路径: ${f.path}`).join("\n");
      const ft = text + (text.trim() ? "\n" : "") + fileNote + "\n\n请读取并解析该文件内容。";
      await _processNormal({ chatKey, text: ft, chatType: message_type === "group" ? "group" : "private", targetId, selfId: String(self_id), userName, userId: String(user_id), images, trigger: message_id, triggerType });
      return;
    }

    // 普通文本消息 → 进入合并缓冲（窗口内连发合并，窗口结束一次回复）
    mergeEnqueue({
      chatKey,
      text,
      chatType: message_type === "group" ? "group" : "private",
      targetId,
      selfId: String(self_id),
      userName,
      userId: String(user_id),
      images,
      trigger: message_id,
      skipMemory: isEmptyAt,
    });
  } catch (err) {
    logErr.error(err?.message);
  }
});

// ---------- 清理 ----------
async function shutdown(reason) {
  logShutdown.info(reason);
  try { await pi.disposeAll(); } catch {}
  bridge.close();
  stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => createLogger("uncaught").error(e));
process.on("unhandledRejection", (e) => createLogger("unhandled").error(e));