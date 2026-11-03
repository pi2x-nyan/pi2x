/**
 * 系统消息留痕队列 —— 让「我发出去的话」进得来会话
 *
 * 【为什么需要】
 * 定时提醒是 cron 脚本直接走 OneBot 发的，绕过了 agent 进程。
 * 结果：QQ 里有一条「提醒你 12:30 排练」，但会话里什么都没有。
 * 用户回一句「看到了」，下一轮的我根本不知道他在应什么 —— 和主动消息当初的毛病一样。
 *
 * 【为什么用文件队列，而不是让 cron 直接写会话】
 * 会话文件由 bridge 进程独占（SessionManager 持有写入句柄）。
 * 进程外直接 append 会和它抢同一个文件，写坏了就是整段历史打不开。
 * 所以 cron 只丢一张「便条」，由 bridge 用自己的句柄落进会话。
 */
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { STATE_DIR } from "./config.mjs";

export const NOTES_FILE = path.join(STATE_DIR, "pending-notes.json");

const notesFile = () => process.env.PI2X_NOTES_FILE || NOTES_FILE;
const MAX = 200;

function read() {
  try {
    const d = JSON.parse(fs.readFileSync(notesFile(), "utf8"));
    return Array.isArray(d?.notes) ? d.notes : [];
  } catch {
    return [];
  }
}

function write(notes) {
  fs.mkdirSync(path.dirname(notesFile()), { recursive: true });
  const tmp = `${notesFile()}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify({ notes }, null, 2), "utf8");
  fs.renameSync(tmp, notesFile());
}

/**
 * 记一张便条。
 * @param {{chat:"private"|"group", target:string, text:string, kind?:string, meta?:object}} o
 */
export function enqueueNote({ chat = "private", target, text, kind = "reminder", meta, now = Date.now() }) {
  const notes = read();
  // 同一条内容在 10 分钟内重复入队没有意义（cron 重试、脚本重入）
  const dup = notes.find((n) => n.chat === chat && n.target === String(target) && n.text === text && now - n.at < 10 * 60000);
  if (dup) return dup.id;
  const id = crypto.randomBytes(4).toString("hex");
  notes.push({ id, chat, target: String(target), text: String(text), kind, meta: meta ?? {}, at: now });
  write(notes.slice(-MAX));
  return id;
}

export function loadNotes() {
  return read();
}

/** 取走全部便条（bridge 用） */
export function drainNotes() {
  const notes = read();
  if (notes.length) write([]);
  return notes;
}

/** 放回（落地失败时别丢，下次再试） */
export function requeueNotes(notes) {
  if (!notes?.length) return;
  const cur = read();
  write([...cur, ...notes].slice(-MAX));
}
