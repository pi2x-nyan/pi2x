/**
 * restart-resume.mjs —— 进程重启后的「自动接续」
 *
 * 【为什么需要】
 * 用户实测反馈：bridge 重启（改代码 / watchdog / 掉电）之后，对话就断在那里了，
 * 必须由用户再发一条消息才能把我叫醒。这有两个后果：
 *   1. 用户得手动「唤醒」——体验上等于 bot 掉线了
 *   2. **重启时正在跑的子代理任务会凭空消失**：_subTasks 是纯内存 Map，
 *      进程一没就全丢，主 agent 永远收不到完成通知，就一直干等（静默中断）
 *
 * 【做法】
 *   ① 子任务派发时落一条 pending 记录到 sessions/subagent-pending.json；
 *      正常结束就删。启动时文件里还剩下的，就是被重启打断的 → 主动通知发起会话。
 *   ② 扫 sessions/*.jsonl，看**尾部**是不是「被打断的回合」（最后一条是带工具调用的
 *      assistant，或 toolResult，或未被回复的 user），且文件在最近 N 分钟内动过
 *      → 给该会话注入一条「自动接续」消息（triggerTurn，空闲时直接开新一轮）。
 *
 * 设计上刻意保守：只处理时间窗内的会话、只处理尾部明显未完成的、每次启动只跑一遍。
 */
import fs from "node:fs";
import path from "node:path";

const PENDING_FILE = "subagent-pending.json";

/**
 * 决定「把 agent 叫醒」时该传什么选项。
 *
 * 【为什么单独抽出来】SDK 的 sendCustomMessage 里 `deliverAs === "nextTurn"` 会
 * **直接入队并 return**，后面的 triggerTurn 分支根本不会求值
 * （dist/core/agent-session.js:1109）。历史代码到处写着
 * `{ triggerTurn: true, deliverAs: "nextTurn" }` —— 看起来两个都要，
 * 实际效果是「只入队、永不唤醒」：通知一直躺着，直到用户下一条消息才被顺带投递，
 * 用户看到的就昿「不叫就不动」。
 *
 * 抽成纯函数后既能被单测钉死，也能避免以后又有人手滑把 deliverAs 加回来。
 *   - 正在流式 → { deliverAs: "steer", triggerTurn: true }  注入当前回合
 *   - 空闲     → { triggerTurn: true }                      真正开新一轮
 */
export function pickNotifyOptions(isStreaming) {
  return isStreaming ? { deliverAs: "steer", triggerTurn: true } : { triggerTurn: true };
}

export function pendingFilePath(sessionsDir) {
  return path.join(sessionsDir, PENDING_FILE);
}

export function loadPendingSubs(sessionsDir) {
  try {
    const raw = fs.readFileSync(pendingFilePath(sessionsDir), "utf8");
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : {};
  } catch {
    return {};
  }
}

export function savePendingSubs(sessionsDir, obj) {
  try {
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.writeFileSync(pendingFilePath(sessionsDir), JSON.stringify(obj ?? {}, null, 1));
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

/** 派发子任务时登记 */
export function markPendingSub(sessionsDir, info) {
  if (!info?.taskId) return;
  const all = loadPendingSubs(sessionsDir);
  all[String(info.taskId)] = {
    taskId: String(info.taskId),
    chatKey: info.chatKey ?? "",
    chatType: info.chatType ?? "private",
    targetId: info.targetId ?? "",
    selfId: info.selfId ?? null,
    userName: info.userName ?? null,
    userId: String(info.userId ?? ""),
    snippet: String(info.snippet ?? "").slice(0, 200),
    ts: Date.now(),
  };
  savePendingSubs(sessionsDir, all);
}

/** 子任务结束时销账 */
export function clearPendingSub(sessionsDir, taskId) {
  const all = loadPendingSubs(sessionsDir);
  if (!all[String(taskId)]) return;
  delete all[String(taskId)];
  savePendingSubs(sessionsDir, all);
}

/**
 * 会话文件名 → { chatKey, userId }
 *   private_<qq>.jsonl          → private:<qq>
 *   group_<gid>_<qq>.jsonl      → group:<gid>（userId 为发言者 <qq>）
 */
export function parseSessionName(name) {
  const base = String(name).replace(/\.jsonl$/, "");
  let m = /^private_(.+)$/.exec(base);
  if (m) return { chatKey: `private:${m[1]}`, userId: m[1] };
  m = /^group_(.+?)_(\d+)$/.exec(base);
  if (m) return { chatKey: `group:${m[1]}`, userId: m[2] };
  return null;
}

/**
 * 读会话文件尾部，判断是不是「被打断的回合」。
 * 返回 { reason } 或 null。
 */
export function tailInterrupted(file) {
  let raw;
  try {
    raw = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const lines = raw.trim().split("\n");
  const last = lines[lines.length - 1];
  if (!last) return null;
  let o;
  try {
    o = JSON.parse(last);
  } catch {
    return null;
  }
  const msg = o?.message ?? {};
  const role = msg?.role;
  const content = Array.isArray(msg?.content) ? msg.content : [];
  const hasToolCall = content.some((s) => s?.type === "toolCall");
  const hasText = content.some((s) => s?.type === "text" && String(s.text ?? "").trim());
  // 带工具调用的 assistant = 工具还没回来就被打断
  if (role === "assistant" && hasToolCall) return { reason: "工具调用未返回" };
  if (role === "toolResult" || role === "tool") return { reason: "模型续写被打断" };
  // 尾部是用户消息 = 还没轮到我回（不管内容长短）
  if (role === "user") return { reason: "用户消息未被 reply" };
  return null;
}

/**
 * 找出「最近活动过」的会话中最新的一条（不看尾部是否完整）。
 *
 * 【为什么需要它】只接续「尾部未完成的回合」是不够的 ——
 * 实测踩到：我先把收尾文本正常发出、进程才重启，会话尾部看起来是个完整回合，
 * 于是判定「无未完成回合」，重启后依旧是一片死寂，用户还是得手动发消息。
 * 用户的原话是「重启后应该自动恢复对话」——重点是**恢复对话**，不是只接续断点。
 * 所以：即使回合已收尾，只要它刚刚还在活动，也应把对话接回来。
 */
export function findLastActive(sessionsDir, withinMs = 10 * 60 * 1000, opts = {}) {
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return null;
  }
  const now = Date.now();
  const skip = opts.skip ?? [];
  let best = null;
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    if (/subagent|subtask/i.test(n)) continue;
    if (skip.some((s) => n.includes(s))) continue;
    const p = parseSessionName(n);
    if (!p) continue;
    const full = path.join(sessionsDir, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > withinMs) continue;
    if (st.size < 2) continue; // 空会话不值得接
    if (!best || st.mtimeMs > best.mtimeMs) {
      best = { file: full, name: n, ...p, mtimeMs: st.mtimeMs, tail: tailInterrupted(full) };
    }
  }
  return best;
}

/**
 * 找出「最近 withinMs 内被改动、且尾部未完成」的会话。
 * 跳过子代理/子任务的一次性会话文件。
 */
export function findInterrupted(sessionsDir, withinMs = 10 * 60 * 1000, opts = {}) {
  const out = [];
  let names;
  try {
    names = fs.readdirSync(sessionsDir);
  } catch {
    return out;
  }
  const now = Date.now();
  const skip = opts.skip ?? [];
  for (const n of names) {
    if (!n.endsWith(".jsonl")) continue;
    if (/subagent|subtask/i.test(n)) continue;
    if (skip.some((s) => n.includes(s))) continue;
    const p = parseSessionName(n);
    if (!p) continue;
    const full = path.join(sessionsDir, n);
    let st;
    try {
      st = fs.statSync(full);
    } catch {
      continue;
    }
    if (now - st.mtimeMs > withinMs) continue;
    const t = tailInterrupted(full);
    if (t) out.push({ file: full, name: n, ...p, ...t, mtimeMs: st.mtimeMs });
  }
  return out.sort((a, b) => b.mtimeMs - a.mtimeMs);
}
