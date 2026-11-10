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
import { proactiveConfig, loadState, shouldRun, recordSent, recordSkip } from "./lib/proactive.mjs";
import { loadEvents, markConsumed, loadWatch, checkFiles, checkUrls } from "./lib/events.mjs";
import { drainNotes, requeueNotes } from "./lib/notes.mjs";
import { systemWakeConfig, resolveWakeChat, createSystemWake, makePiSessionSubmit } from "./lib/system-wake.mjs";
import { buildTrigger, strengthOf, appendDisposition } from "./lib/trigger.mjs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ensureOnebotConfig, start, waitForReady, stop, isRunning } from "./lib/napcat.mjs";
import { QQBridge } from "./lib/qqbridge.mjs";
import { createPiAgent } from "./lib/piagent.mjs";
import * as sst from "./lib/strix-session.mjs";
import { createLogger } from "./lib/log.mjs";
import { ROOT, STATE_DIR, WORKSPACE, config } from "./lib/config.mjs";
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
/* 系统唤醒（外部事件 → Router）单独一个 scope，方便 grep 事件链路 */
const logWake = createLogger("system-wake");
/* strix 框架会话的收发日志（与 pi 主链路分开，排查时一眼能分辨走的是哪个框架） */
const logSxRecv = createLogger("strix-recv");
const logSxErr = createLogger("strix-error");

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
/**
 * 展开合并转发，并把里面的图一并抽出来挂到 ev._forwardImages。
 *
 * 【为什么要把图挂到 ev 上】转发正文会被渲染成文本（图的位置只剩「[图片]」占位符），
 * 图本身如果不单独带出来，collectImages 永远看不到 —— 模型就一直「看不见图」。
 * 挂 ev 上是最小侵入的传递方式：下游 collectImages 持有 ev 引用，可直接取。
 *
 * @param {object} bridge
 * @param {any[]} message 原始消息段数组
 * @param {string} rawText 渲成文本后的消息
 * @param {object} [ev] OneBot 事件对象（写入 _forwardImages）
 */
async function expandForward(bridge, message, rawText, ev) {
  const seg = (Array.isArray(message) ? message : []).find((s) => s.type === "forward" || s.type === "json" || s.type === "xml");
  const idMatch = /\[转发 id:([^\]]+)\]/.exec(rawText);
  const fid = idMatch?.[1] ?? seg?.data?.id ?? seg?.data?.message_id ?? "";
  if (!fid) return rawText.replace(/\[转发[^\]]*\]/, "〔转发消息（无法识别转发 id）〕");
  try {
    const res = await bridge.getForwardMsg(fid);
    const items = QQBridge.parseForwardMessages(res);
    const block = QQBridge.renderForward(items);
    const imgs = items.flatMap((it) => it.images ?? []);
    if (ev && imgs.length) ev._forwardImages = imgs;
    logMerge.info(`展开合并转发 id=${fid} · ${items.length} 条${imgs.length ? ` · 含 ${imgs.length} 张图` : ""}`);
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

/** 把一组图片引用落成 SDK ImageContent[]（失败逐个降级，不抛）
 * @param {object[]} parts 图片段 data（{file,url,...}）
 * @param {object} bridge QQBridge 实例
 * @returns {Promise<Array<{type:'image',data:string,mimeType:string}>>} */
async function fetchImageParts(parts, bridge) {
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
        try {
          const resp = await fetch(img.url);
          if (resp.ok) {
            const ab = await resp.arrayBuffer();
            if (ab.byteLength <= MAX_IMAGE_BYTES) { buf = Buffer.from(ab); name = img.url; }
          }
        } catch { /* 下面统一报 */ }
      }
      if (buf) {
        const mimeType = detectMime(buf) ?? "image/png";
        out.push({ type: "image", data: buf.toString("base64"), mimeType });
        logImg.info(`已收集图片 ${name.slice(-40)} (${buf.length} 字节, ${mimeType})`);
      } else {
        logImg.warn(`图片获取失败（超大小或无路径/URL）file=${String(img.file ?? "").slice(-30)}`);
      }
    } catch (e) {
      logImg.warn(`图片获取失败: ${e?.message}`);
    }
  }
  return out;
}

/** 收集消息中的图片 → SDK ImageContent[] {type:'image', data(base64), mimeType}
 *
 * 【为什么要收引用与转发里的图】旧实现只扫顶层 image 段，于是：
 *   · 群里引用一条图片消息再 @bot → 图在 reply 段里，抓不到；
 *   · 转发一整个聊天记录 → 里面的图只以「[图片]」占位符出现在正文。
 * 模型收到的是占位符，就变成了「我看不见图」——这正是 RA 反馈的现场。
 *
 * 现在：顶层图 + 引用消息里的图 + 合并转发里的图 一起收。
 * 顺序与正文中出现的次序一致（引用图在前，转发图在后），方便模型对应
 * renderForward 里打出的 <图片 N> 标号。
 */
async function collectImages(ev, bridge) {
  const refs = [];

  // ① 顶层图片（原有行为）
  refs.push(...QQBridge.extractImages(ev.message));

  // ② 引用消息里带的图
  //    NapCat 的 reply 段通常**只有 id**，不内联被引用消息的正文 ——
  //    这就是「引用一张图问它是什么，bot 回看不见图」的根因（2026-11-03 群里复现）。
  //    所以：先看有没有内联，没有就按 id 回捞一次 get_msg。
  for (const seg of Array.isArray(ev.message) ? ev.message : []) {
    if (seg?.type !== "reply" || !seg.data) continue;
    let nested = QQBridge.collectImageRefs(seg.data.message ?? seg.data.content ?? []);
    if (!nested.length) {
      const qid = seg.data.id ?? seg.data.message_id;
      if (qid) {
        try {
          const quoted = await bridge.getMsg(qid);
          const msg = quoted?.message ?? quoted?.data?.message ?? [];
          nested = QQBridge.collectImageRefs(msg);
          if (nested.length) logImg.info(`引用消息(${qid})内补捞到 ${nested.length} 张图`);
        } catch (e) {
          logImg.warn(`引用消息(${qid})回捞失败: ${e?.message}`);
        }
      }
    }
    if (nested.length) refs.push(...nested);
  }

  // ③ 合并转发里的图（expandForward 已把它们抽好存在 ev._forwardImages）
  if (Array.isArray(ev._forwardImages) && ev._forwardImages.length) {
    refs.push(...ev._forwardImages);
    logImg.info(`转发消息内附带 ${ev._forwardImages.length} 张图，一并收集`);
  }

  if (!refs.length) return [];
  return fetchImageParts(refs, bridge);
}

// ---------- 文件接收辅助（非图片文件 → 落地到 workspace/downloads/） ----------
const DOWNLOAD_DIR = path.join(WORKSPACE, "downloads");
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

// ---------- 2.5 /dev 设备节点自愈 ----------
// 本机是 Android chroot，/dev 是普通空目录（非 devtmpfs）。若 /dev/urandom 不存在，
// 后续一切需要随机字节的操作都会失败（git 建临时文件、Node 取熵）。
// 这里在业务开始前补一遍，并写日志 —— 否则这个隐患只会在某个无关操作里以
// “unable to get random bytes”这种难懂的方式暴露出来。
try {
  const { healDevNodes } = await import("./lib/devnodes.mjs");
  const r = healDevNodes();
  if (!r.ok) logBoot.warn(`/dev 自愈未完全成功：${r.reason}`);
  else if (r.changed) logBoot.info(`/dev 设备节点已修复（${r.changed.join(", ")}）`);
} catch (e) {
  logBoot.warn(`/dev 自愈异常（不影响启动）：${e?.message}`);
}

// ---------- 3. 连接 QQ ----------
const nb = config.napcat.onebot;
const bridge = new QQBridge({ host: nb.wsHost, port: nb.wsPort, token: nb.token });
await bridge.connect();

// ---------- 3.9 会话活跃时间（供主动回合判定） ----------
const _lastUserMsgAt = new Map();

// ---------- 4. pi agent ----------
const pi = createPiAgent({ bridge });
await pi.init();
logBoot.info("pi agent 就绪，PI2X 开始工作");

// ---------- 4.2 strix 孤儿清扫 ----------
// strix 常驻会话是独立子进程，不会随 bridge 一起被系统带走。上一轮如果被
// kill -9 / OOM（watchdog 重启、掉电），那些 worker 就变成孤儿进程，带着一整套
// strix agent 和 headless Chrome 白跑（烧钱 + 占着会话目录）。启动瞬间不可能有
//「属于当前进程」的 worker，所以这里看到的全是孤儿，直接杀。
try {
  const n = sst.sweepStrixOrphans();
  if (n) logBoot.warn(`清理 ${n} 个残留的 strix 会话进程（上次未正常退出）`);
} catch (e) {
  logBoot.warn(`strix 孤儿清扫失败（不影响启动）：${e?.message}`);
}

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

// ---------- 4.7 主动回合（proactive） ----------
// 与 4.5 的「生命周期心跳」不是一回事：那个只写 token 给看门狗；
// 这个是让 agent 周期性自检「有没有该主动说的事」。
// 默认关闭，配置在 config.pi.proactive；四道闸（静默时段/冷却/每日上限/用户活跃）在 lib/proactive.mjs。
{
  const pcfg = proactiveConfig(config.pi?.proactive);
  if (!pcfg.enabled) {
    logBoot.info("主动回合：未启用（config.pi.proactive.enabled=false）");
  } else {
    const tick = async () => {
      try {
        const st = loadState();
        // 先跑一次事件源巡检（文件 mtime / 网页 hash），把它们变成事件入队
        try {
          const w = loadWatch();
          if ((w.files ?? []).length) checkFiles(w);
          if ((w.urls ?? []).length) await checkUrls(w);
        } catch (e) { logBoot.warn(`事件源巡检失败：${e?.message}`); }
        const pending = loadEvents();
        for (const chatKey of pcfg.chats) {
          const [chatType, targetId] = String(chatKey).split(":");
          const verdict = shouldRun({
            cfg: pcfg, state: st, chatKey, now: Date.now(),
            lastUserMsgAt: _lastUserMsgAt.get(chatKey) ?? 0,
          });
          // 事件是新信息：可以绕过「冷却」，但静默时段/每日上限/用户活跃三道闸仍然生效
          const isEventTurn = pending.length > 0;
          let reason = verdict.reason;
          let run = verdict.run;
          if (!run && isEventTurn && reason === "cooldown") { run = true; reason = "event-bypass-cooldown"; }
          if (!run) continue;
          logBoot.info(`主动回合触发：${chatKey}（${reason}${isEventTurn ? " · 事件" : ""}）`);
          const uid = String(targetId);
          const r = await pi.runProactiveTurn({
            chatKey, chatType, targetId: uid, userId: uid,
            events: isEventTurn ? pending : null,
          });
          if (r.skip) {
            // 模型判断“不值得说”的事件也要消费掉，否则它每分钟都会再触发一次
            if (isEventTurn) markConsumed(pending.map((e) => e.key || e.id));
            recordSkip({ state: st, chatKey });
            logBoot.info(`主动回合：未发言（${r.reason ?? "skip"}）`);
            continue;
          }
          // 发送与留痕都在 runProactiveTurn 里做（先发后记），这里只记状态
          recordSent({ state: st, chatKey });
          if (isEventTurn) markConsumed(pending.map((e) => e.key || e.id));
          logBoot.info(`主动回合已发送：${chatKey}（${r.text.length} 字）`);
        }
      } catch (e) {
        logBoot.warn(`主动回合异常：${e?.message}`);
      }
    };
    const t = setInterval(tick, 60_000);
    t.unref?.();
    process.on("SIGTERM", () => clearInterval(t));
    logBoot.info(`主动回合已启动：${pcfg.chats.join(",") || "(无会话)"}，间隔 ${pcfg.intervalMinutes} 分钟，每日上限 ${pcfg.dailyMax}`);
  }
}

// ---------- 4.7b 系统唤醒（外部事件 → Router） ----------
// 4.7 的主动回合开关一关，事件队列就彻底没人消费了：挂课看门狗/磁盘告警把事写进
// 队列，Router 永远不知道（2026-11-04 挂课卡死 17 小时，事件链路完全没参与）。
// 这里独立轮询，与 proactive 开关无关；节流与每日额度在 lib/system-wake.mjs。
{
  const swCfg = systemWakeConfig(config.pi?.systemWake);
  const swChat = resolveWakeChat(swCfg, config.pi?.proactive?.chats);
  if (!swCfg.enabled) {
    logWake.info("系统唤醒：未启用（config.pi.systemWake.enabled=false）");
  } else if (!swChat) {
    logWake.warn("系统唤醒：没有唤醒目标会话（config.pi.systemWake.chat），通道不启动");
  } else {
    // 复用 _wakeSubDone 的提交方式：会话空闲 → triggerTurn 开新一轮；正忙 → steer 注入。
    const submit = makePiSessionSubmit(pi);
    const wake = createSystemWake({ cfg: swCfg, chatKey: swChat, submit, logger: logWake });
    let busy = false;
    const tick = async () => {
      // 唤醒可能走完一整轮（几分钟），期间不叠第二次
      if (busy) return;
      busy = true;
      try {
        await wake.tick();
      } catch (e) {
        logWake.warn(`系统唤醒异常：${e?.message}`);
      } finally {
        busy = false;
      }
    };
    const t = setInterval(tick, swCfg.intervalSec * 1000);
    t.unref?.();
    process.on("SIGTERM", () => clearInterval(t));
    setTimeout(tick, 10_000); // 启动后先扫一次，把重启期间积压的事件接上
    logWake.info(
      `系统唤醒通道已启动：${swChat}，每 ${swCfg.intervalSec} 秒，类型 ${swCfg.types.join("/")}，` +
        `同 key ${swCfg.throttleMinutes} 分钟一次，每日上限 ${swCfg.dailyMax}`,
    );
  }
}

// ---------- 4.8 系统消息留痕（提醒等） ----------
// 提醒是 cron 直接发的，会话里没有记录；不补的话，用户回「看到了」我不知道在说什么。
// 每 30 秒扫一次便条队列，用 bridge 自己的句柄写进对应会话，避免两个进程抢同一个文件。
{
  const tick = async () => {
    let notes = [];
    try { notes = drainNotes(); } catch { return; }
    if (!notes.length) return;
    const failed = [];
    for (const n of notes) {
      // 群消息不落：群会话按用户隔离，一条群提醒没有明确的归属用户
      if (n.chat !== "private") continue;
      try {
        const ok = await pi.recordSystemNote({ chatKey: `private:${n.target}`, userId: String(n.target), text: n.text, kind: n.kind ?? "reminder" });
        if (!ok) failed.push(n);
      } catch (e) {
        logBoot.warn(`留痕异常：${e?.message}`);
        failed.push(n);
      }
    }
    if (failed.length) { try { requeueNotes(failed); } catch {} }
  };
  const t = setInterval(tick, 30_000);
  t.unref?.();
  process.on("SIGTERM", () => clearInterval(t));
  setTimeout(tick, 8000); // 启动后先扫一次，把重启期间积压的补上
  logBoot.info("系统消息留痕已启动（每 30 秒）");
}

// ---------- 4.6 闲置压缩巡检 ----------
// 为什么不能用「轮次结束时检查」代替：上下文停在 30%（低于 40% 阈值）后若一直没人
// 说话，就没有任何轮次结束，检查逻辑永远不执行 —— 下次开口时又带着陈旧上下文请求。
// 闲置期正是压缩的最佳时机（没人在等回复）。
// 注意：工具执行跑很久属于**忙碌**，巡检里会跳过（见 _startIdleCompact 的注释）。
try {
  // 变量名是 pi（createPiAgent 的返回值），别写成 agent —— 我第一版就写错了，
  // 结果启动日志里只有一句 warn「agent is not defined」，巡检静默没起来。
  pi._startIdleCompact?.();
} catch (e) {
  logBoot.warn(`闲置压缩启动失败: ${e?.message}`);
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
  // 进了这一轮：记一条 accepted，和上面被筛掉的记录合起来就是完整处置链
  try {
    appendDisposition(path.join(STATE_DIR, "triggers.jsonl"), {
      triggerId: b.trigger ? `qq-${b.trigger}` : `qq-batch-${Date.now()}`,
      threadKey: `qq:${b.chatType}:${chatKey.split(":").pop()}`,
      disposition: { evalId: chatKey, accepted: b.texts.length },
    }, { append: (line) => fs.appendFileSync(path.join(STATE_DIR, "triggers.jsonl"), line, "utf8") });
  } catch { /* 记账失败不影响回复 */ }
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

  // ── strix 框架路由（仅 admin 私聊，已在 /strix 入口鉴权）────────────────
  // 该会话已接入 strix 时，消息不再进 PI2X 主 agent，而是注入 strix 常驻会话。
  // 【为什么放在 handleMessage 之前】切了框架就该真的换执行体，而不是把消息
  // 同时喂给两边 —— 那会变成两个 agent 抢答，还可能各自重复动手。
  //
  // 【为什么这里还要再判一次私聊】切换入口已经拦了群聊，但路由是最后一道；
  // 万一以后有别的路径建出了群里的实例（配置改动/热重载），也不能让渗透输出
  // 落到群里。两道判断是有意重复的。
  if (chatType !== "group") {
    const sx = sst.peekStrixSession(String(userId), chatKey);
    // `hasPending` 也要算进来：/strix new 是**懒启动**（只登记不拉进程），
    // 用户的第一句话必须交给 strix 当任务，而不是被 PI2X 主 agent 抢去回答。
    if (sx && (sx.alive || sx.hasPending)) {
      await _processStrix({ sx, chatKey, text, chatType, targetId, userId, userName, images });
      return;
    }
  }

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

/** 把一条消息注入 strix 会话，并把它的输出分段发回 QQ。
 *
 * strix 一轮可能跑很久（分钟到小时）。这里**不阻塞在单次回复上**：
 *   · 先立刻回一句「已收到，在跑」，把当前进度同步给用户
 *   · 然后用 send() 收集直到本轮 park（agent 说完了/等人）
 * 若本轮跑到 IDLE_GRACE_MS 还没结束，send() 会先把已有的输出交回来。
 */
async function _processStrix({ sx, chatKey, text, chatType, targetId, userId, userName, images }) {
  const send = async (body) => {
    if (!body) return;
    const parts = splitReply(body, Number(config.pi.maxReplyChars) || 1500);
    for (const part of parts.slice(0, 8)) {
      if (chatType === "group") await bridge.sendGroupMsg(Number(targetId), part);
      else await bridge.sendPrivateMsg(Number(userId), part);
      await new Promise((r) => setTimeout(r, 300));
    }
  };

  if (images?.length) {
    logSxRecv.warn(`${chatKey}: strix 模式暂不支持图片输入，已忽略 ${images.length} 张`);
  }

  logSxRecv.info(`${chatKey} <${userName}>: ${String(text).slice(0, 80)}`);
  try {
    const r = await sx.send(text);
    const body = r.text || "（strix 本轮没有输出；可用 /strix status 看状态）";
    const tail = r.costUsd != null ? `\n\n· strix 累计 $${Number(r.costUsd).toFixed(4)}` : "";
    await send(body);
    if (tail) await send(tail.trim());
    logSent.info(`${chatKey}[strix]: ${body.replace(/\n/g, " ").slice(0, 60)}`);
  } catch (e) {
    logSxErr.error(`strix 执行失败: ${e?.message}`);
    await send(`strix 执行失败：${e?.message}\n可试 /strix status 看状态，或 /pi2x 先退回主框架。`);
  }
}

bridge.on("event", async (ev) => {
  if (ev.post_type !== "message") return;
  if (isDuplicate(ev.message_id)) return;

  const { message_type, user_id, group_id, self_id, message, message_id } = ev;
  const rawText0 = QQBridge.extractText(message).trim();

  // 【Trigger 记账】借鉴 dsh-superagent：每条进来的消息先落成结构化 Trigger，
  // 再记一条 disposition（进了哪一轮 / 为什么没进）。只追加不改写，
  // 目的是事后能回答「这条为什么不回」「这条归哪个任务」——以前全靠翻日志猜。
  const trgPath = path.join(STATE_DIR, "triggers.jsonl");
  const mkTrigger = (mentionsMe) => buildTrigger({
    id: `qq-${message_id}`,
    chatType: message_type,
    chatId: message_type === "group" ? group_id : user_id,
    userId: user_id,
    userName: ev.sender?.card || ev.sender?.nickname,
    text: rawText0,
    mentionsMe,
    isBot: String(user_id) === String(self_id),
    at: new Date().toISOString(),
  });
  const note = (trigger, disposition) => {
    try { appendDisposition(trgPath, { triggerId: trigger.id, threadKey: trigger.threadKey, disposition }, { fs }); }
    catch { /* 记账失败不影响主流程 */ }
  };

  // 【群聊屏蔽 @全体成员】
  // @全体成员 是面向全群的公告，语义上不是「叫 bot」；旧的 isMentioned 把 qq==="all"
  // 也算命中，导致任何一条群公告都会把 bot 从潜水里拽醒、白烧一遍 token。
  // 按用户要求：这类消息**整条忽略**（不进模型、不回复、不拉引用全文、不展开转发）。
  // 唯一后门：消息**另外单独 @ 了 bot 本人**时仍放行 —— 那是明确指向。
  // 放在这个位置（解析引用/转发之前）是故意的 —— 让被屏蔽的消息连网络请求都不发出去。
  // 判定本身在 QQBridge.shouldIgnoreAtAll（纯函数，可单测）。
  if (message_type === "group" && config.permissions?.ignoreAtAll !== false) {
    if (QQBridge.shouldIgnoreAtAll(message, self_id, rawText0)) {
      logRecv.info(
        `忽略 @全体成员 消息（群 ${group_id} / ${ev.sender?.card || ev.sender?.nickname || user_id}）: ${rawText0.slice(0, 60)}`,
      );
      const t0 = mkTrigger(true);
      note(t0, { filtered: { code: "at_all" }, strength: "none" });
      return;
    }
  }
  // 引用全文增强：reply 段带 id → get_msg 拉被引用消息全文（失败则保留段内自带预览）
  // 注：extractText 产出的标记是 [引用…]（NapCat reply 段只给 id，不含文本，必须 get_msg 拉全文）
  let rawText = rawText0;
  let quotedFromSelf = false;   // 这条消息是不是在引用我自己发的东西
  // 顶层 message 里直接带 forward 段 → 这条消息本身就是一张聊天记录卡片（直接发的）；
  // 若 [转发 id:...] 只出现在引用块里（rawText 有 [引用 且顶层无 forward 段），
  // 则属于「引用了一条转发」，那种情况才展开。
  const directForward =
    message_type === "group" &&
    Array.isArray(message) &&
    message.some((s) => s.type === "forward");
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
        // 被引用的是不是我自己：用于「这句话是在补给我的某个工单」的判定
        if (sd.user_id != null && String(sd.user_id) === String(self_id)) quotedFromSelf = true;
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
    // 【群聊里不自动展开聊天记录】按用户要求：群里别人直接发的合并转发（聊天记录卡片）
    // **不喂给模型** —— 那本质上是把一群人的对话整段灌进上下文，既噪又牵涉他人隐私，
    // 而且发送者未必是想让 bot 读它。
    // 只有用户**主动引用**（回复）某条转发时才展开：那是明确的「请你看看这个」。
    // 私聊不受此限 —— 私聊里转发给 bot 本身就是明确意图。
    if (directForward) {
      // 降级成说明性占位符而不是直接删掉：让模型知道「这里有一条转发、我没读」，
      // 才不会以为消息是空的，也不会凭空编造内容。
      rawText = rawText.replace(
        /\[转发[^\]]*\]/,
        "〔转发消息（群聊默认不展开；如需我看，请引用该条转发）〕",
      );
    } else {
      rawText = await expandForward(bridge, message, rawText, ev);
    }
  }
  if (!rawText) return;

  // 群聊：响应判定 = @bot（at 段/文本 @）或喊名字（消息任意位置含 PI2X/2X/机器人）；无指向消息一律潜水
  const atSeg = QQBridge.isMentioned(message, self_id);
  const nickM = rawText.match(/^@([^\s]+)\s*/); // 文本 @xxx
  // 注：这里**不再**把 nickM[1] === "all" 当唤醒条件 —— @全体成员 已在开头被整条忽略，
  // 若这里还认 all，就等于给屏蔽开了个后门（文本 @all 仍会命中）。
  const textBot = nickM && (nickM[1] === String(self_id) || nickM[1] === "PI2X" || nickM[1] === "2X");
  // 喊名字唤醒（借鉴大肥鸭：被@/喊名字才醒）
  const nameKeywords = config.permissions?.nameKeywords ?? ["pi2x", "2x", "机器人"];
  const nameRe = new RegExp("(" + nameKeywords.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") + ")", "i");
  const hasName = nameRe.test(rawText);
  const triggerType = (atSeg || textBot) ? "@唤醒" : "名称唤醒";
  if (message_type === "group") {
    if (!atSeg && !textBot && !hasName) {
      // 无任何指向 → 潜水（冒泡功能已取消）；记一条，方便日后查「这条为什么没被接」
      note(mkTrigger(false), { filtered: { code: "not_addressed" }, strength: "none" });
      return;
    }
    if (!allowed("group", group_id)) return;
  } else {
    if (!allowed("user", user_id)) return;
  }

  const chatKey = message_type === "group" ? `group:${group_id}` : `private:${user_id}`;
  const targetId = message_type === "group" ? String(group_id) : String(user_id);
  const userName = ev.sender?.card || ev.sender?.nickname || String(user_id);

  // 【工单接力】人引用了我发的通知再说一句 → 这句话属于那个工单，递进去，不再另起一轮。
  // 对应 dsh-superagent 的 follow-up ownership：消息在工单线程上，就归那个 Executor 处理。
  // 默认关闭（config.pi.superagent.followupRouting），因为一旦误判，用户会觉得"我说的话没人理"。
  if (quotedFromSelf && config.pi?.superagent?.followupRouting) {
    try {
      const rt = pi?.tickets;
      const live = rt ? rt.store.live().filter((t) => t.chatKey === `qq:${chatKey}`) : [];
      const t = live[live.length - 1];
      if (t) {
        rt.attachInput(t.id, { human: true, text: rawText, triggerId: `qq-${message_id}` });
        const task = [...(pi._subTasks?.values?.() ?? [])].find((x) => x.ticketId === t.id && (x.status === "running" || x.status === "pending"));
        if (task) {
          // worker 还活着：这句话直接递进去（attach），不再另起一轮
          await pi._subSteer(task, rawText).catch(() => {});
          rt.recordDecision({ triggerId: `qq-${message_id}`, action: "attach", ticketId: t.id, chatKey: `qq:${chatKey}`, reason: "live_worker" });
          logRecv.info(`${chatKey} 工单接力 → ${t.id}（attach 到在跑的 worker）`);
        } else {
          // worker 已经收工：这句话等于让它接着干（requeue）
          const r = await pi._requeueTicket(t.id, rawText);
          rt.recordDecision({ triggerId: `qq-${message_id}`, action: r.ok ? "requeue" : "attach", ticketId: t.id, chatKey: `qq:${chatKey}`, reason: r.ok ? "resume" : "no_ticket" });
          logRecv.info(`${chatKey} 工单接力 → ${t.id}（${r.ok ? `requeue 续跑 ${r.taskId}` : "仅记账"}）`);
        }
        note(mkTrigger(true), { fanout: [t.id], via: "followup" });
        return;   // 不再进入普通回合
      }
    } catch (e) {
      logRecv.warn(`工单接力失败，回退到普通回合: ${e?.message}`);
    }
  }

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
      // 群聊空@：拉取该群最近聊天记录作为上下文，让模型基于真实历史推断，而不是猜。
      //
      // 【为什么这里与「转发卡片」的处理不同】两者容易混淆，区别在**意图归属**：
      //   · 空@ 是**明确 @ 了 bot**，属于被请求 → 拉本群自己的近期上下文是合理的；
      //   · 群里别人随手转发的聊天记录卡片并没有指向 bot，且内容可能来自别处
      //     （含他人对话），所以不整段灌进模型，只在被引用时才展开（见 expandForward 调用处）。
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
    // 记录会话活跃时间（主动回合据此判断「用户刚说完话就别插嘴」）
    try { _lastUserMsgAt.set(chatKey, Date.now()); } catch {}
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
  // strix 常驻会话也要收掉：它们是独立子进程，不随 bridge 进程退出
  try { await sst.disposeAllStrix(); } catch {}
  bridge.close();
  stop();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("uncaughtException", (e) => createLogger("uncaught").error(e));
process.on("unhandledRejection", (e) => createLogger("unhandled").error(e));