/**
 * 当前会话记录 —— 让「子进程」也能知道「这个人刚才在哪个群说话」。
 *
 * 【为什么需要这个文件】
 *
 * `group_history`（查群聊记录）要对所有人开放，但开放的前提是**不能随便查任意群**：
 * 否则任何 friend / dialog 用户只要在私聊里说一句「查群 123456 的记录」，
 * 就能把别人群的聊天记录整段拉出来。群聊记录是别人的隐私，这条线不能松。
 *
 * 于是规则是：非特权用户只能查**自己当前所在的群**。问题在于 qq-cli 是
 * **独立子进程**：它由模型经 bash 拉起，拿不到主进程里那份 turn-context（ALS 只活在进程内）。
 * 所以主进程必须在每轮对话开始时，把「谁、在哪种会话、目标 id」落到一个文件里，
 * 子进程再去读。
 *
 * 【为什么用文件而不是参数】参数是模型自己填的 —— 模型可以被提示注入诱导填一个别的群号，
 * 那样这条限制就形同虚设。文件由主进程写、模型改不了（普通用户没有文件权限），
 * 才构成真正的边界。
 */
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.mjs";

const FILE = path.join(STATE_DIR, "active-chat.json");

/** 超过这个时长的记录不再可信（人早跑去别的群了，旧记录没有意义） */
export const ACTIVE_CHAT_TTL_MS = 30 * 60 * 1000;

function readAll() {
  try {
    const d = JSON.parse(fs.readFileSync(FILE, "utf8"));
    return d && typeof d === "object" ? d : {};
  } catch {
    return {};
  }
}

/**
 * 记下某人当前所在的会话。每轮对话开始时调用。
 *
 * 写失败一律吞掉：这只是给子进程用的旁路信息，绝不能因为它让正常回复挂掉。
 *
 * @param {string|number} userId
 * @param {"private"|"group"} chatType
 * @param {string|number} targetId 群号或对方 QQ
 * @param {number} [now]
 * @returns {boolean} 是否写入成功
 */
export function rememberChat(userId, chatType, targetId, now = Date.now()) {
  const uid = String(userId ?? "").trim();
  const tid = String(targetId ?? "").trim();
  if (!uid || !tid) return false;
  try {
    const all = readAll();
    // 顺手清掉过期项，避免文件无限长大
    for (const [k, v] of Object.entries(all)) {
      if (!v || typeof v.at !== "number" || now - v.at > ACTIVE_CHAT_TTL_MS) delete all[k];
    }
    all[uid] = { chatType: chatType === "group" ? "group" : "private", targetId: tid, at: now };
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(all));
    fs.renameSync(tmp, FILE);
    return true;
  } catch {
    return false;
  }
}

/**
 * 取某人当前所在的会话（过期或不存在都返回 null）。
 * @param {string|number} userId
 * @param {number} [now]
 * @param {number} [ttlMs]
 * @returns {{chatType:"private"|"group", targetId:string, at:number}|null}
 */
export function currentChatOf(userId, now = Date.now(), ttlMs = ACTIVE_CHAT_TTL_MS) {
  const uid = String(userId ?? "").trim();
  if (!uid) return null;
  const v = readAll()[uid];
  if (!v || typeof v.at !== "number" || typeof v.targetId !== "string") return null;
  if (now - v.at > ttlMs) return null;
  return { chatType: v.chatType === "group" ? "group" : "private", targetId: v.targetId, at: v.at };
}
