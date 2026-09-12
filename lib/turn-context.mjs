/**
 * 回合上下文（turn context）—— 每个会话各自的「我是谁、在跟谁说话」
 *
 * 【这个文件要解决的问题：一个真实的隐私竞态】
 *
 * 原先上下文存在 `PiAgent` 实例字段 `this.ctx` 上，是**全局单例**。
 * 但多个会话是可以并发跑的（私聊 / 群聊 / 子代理各自独立，互不等待），
 * 于是出现这样的时序：
 *
 *   会话A: this.ctx = {群999, 用户111}       ← 建立自己的上下文
 *   会话A: await 记忆检索…（耗时数秒）        ← 在这里被切走
 *   会话B: this.ctx = {私聊, 用户222}         ← 把单例覆盖掉
 *   会话A: 继续执行，读 this.ctx → 拿到 B 的上下文 ❌
 *
 * 后果（按严重程度）：
 *   · qq_send_message / qq_send_file 按 ctx.targetId 发送 → **消息/文件发进别人的会话**
 *   · save_memory 按 ctx 记来源 → 私聊的事实被写进群共享记忆（同群所有人可见）
 *   · search_memories 对非管理员强制用 ctx.userId 过滤 → 可能读到别人的记忆
 *   · clear_history 按 ctx.userId 删文件 → 可能删掉别人的聊天历史
 *   · set_reminder 的默认投递目标 → 提醒发给了别人
 *   · 模型人格按 ctx.userId 选 → 用错人的语气说话
 *
 * 这不是理论推演：记忆库里确实出现过一条「私聊会话写进去、来源却是群」的记录
 * （见 commit bdd275f），正是这个竞态留下的痕迹。
 *
 * 【修法】
 * 用 AsyncLocalStorage 承载上下文 —— 与 lib/log.mjs 的轮次 ID 同一套机制。
 * ALS 随异步链自动继承，因此「在哪个回合里执行」是确定的，与并发无关。
 * this.ctx 保留为**回合外**的兜底（例如内置命令路径），不再是回合内的真相来源。
 */
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs";

const store = new AsyncLocalStorage();

/**
 * 在给定上下文里执行函数。异步链内所有 getTurnCtx() 都返回这份上下文。
 *
 * @template T
 * @param {object} ctx {chatType, targetId, selfId, userName, userId, chatKey, currentSessionKey}
 * @param {() => T} fn
 * @returns {T}
 */
export function runWithTurnCtx(ctx, fn) {
  // 浅拷贝：避免调用方后续修改同一个对象引用造成串味
  return store.run({ ...ctx }, fn);
}

/** 取当前回合上下文；不在任何回合内返回 null */
export function getTurnCtx() {
  return store.getStore() ?? null;
}

/**
 * 就地更新当前回合上下文的某个字段（例如写入 memInjection）。
 * 只影响当前异步链，不会波及其他并发会话。
 * @returns {boolean} 是否成功（不在回合内时返回 false）
 */
export function patchTurnCtx(patch) {
  const cur = store.getStore();
  if (!cur) return false;
  Object.assign(cur, patch);
  return true;
}

/** 删除当前回合上下文的某个字段 */
export function deleteTurnCtxField(key) {
  const cur = store.getStore();
  if (!cur) return false;
  delete cur[key];
  return true;
}

/**
 * 把当前回合上下文抄成一份「快照」（供调试/dump 用）
 */
export function snapshotTurnCtx() {
  const cur = store.getStore();
  return cur ? { ...cur } : null;
}

export default { runWithTurnCtx, getTurnCtx, patchTurnCtx, deleteTurnCtxField, snapshotTurnCtx };
