/**
 * trigger —— 把「一条进来的消息」变成有结构的 Trigger
 *
 * 借鉴 dsh-superagent（docs/001 Domain model + src/core/intake.ts）：
 *   Trigger = {id, source, threads[], actor, human, addressed, at, text, channel, meta}
 *   进来先落成 Trigger，再判「听不听」→ 听就分发给工单，不听就记一条 disposition 说明为什么。
 *
 * 为什么值得抄：以前 PI2X 收到消息就是「文本 → 开一轮」，没有中间那层。
 * 于是三件事只能靠提示词和零散判断去兜：
 *   · 这条到底算不算「请求我」（群里没 @ 的闲聊、随手的感叹）
 *   · 这条是谁说的（人 / 别的机器人 / 我方自己的回显）
 *   · 这条属于哪条线（是不是在回我上一个通知，跟哪个任务有关）
 * 有了 Trigger，这些变成字段，路由判定变成代码，事后还能复盘「当时为什么没接」。
 */

/** 会话线程：同一会话里，引用同一条根消息的归到一个 thread */
export function threadKeyOf({ chatType, chatId, replyRootId }) {
  const base = `qq:${chatType}:${chatId}`;
  return replyRootId ? `${base}:r${replyRootId}` : base;
}

/**
 * 造一个 Trigger。
 * @param {object} m QQ 侧的消息快照
 * @param {string} m.chatType   private | group
 * @param {string|number} m.chatId
 * @param {string|number} m.userId
 * @param {string} [m.userName]
 * @param {string} m.text
 * @param {boolean} [m.mentionsMe]  群里是否 @ 了我（或引用了我）
 * @param {boolean} [m.isBot]       发送者是否是机器人 / 我方回显
 * @param {string|number} [m.replyRootId] 引用链的根
 * @param {string} [m.at]           ISO 时间
 */
export function buildTrigger(m = {}) {
  const chatType = m.chatType === "group" ? "group" : "private";
  const at = m.at ?? new Date().toISOString();
  const text = String(m.text ?? "");
  const addressed = chatType === "private"
    ? "direct"
    : (m.mentionsMe ? "mention" : undefined);
  const id = m.id ?? `trg-${Date.parse(at) || Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  return {
    id,
    source: "qq",
    threadKey: threadKeyOf({ chatType, chatId: m.chatId, replyRootId: m.replyRootId }),
    channel: { chatType, chatId: String(m.chatId ?? "") },
    actor: { id: String(m.userId ?? ""), name: m.userName ?? null, bot: !!m.isBot },
    human: !m.isBot,
    addressed,
    at,
    text,
    meta: { len: text.length },
  };
}

/**
 * 触发强度，照 superagent 的口径分三档：
 *   explicit  明确请求我（私聊直发 / 群里 @ 我 / 名单内的人对我说话）
 *   inferred  不是对我说的，但落在已放开的范围里（团队规则允许去听）
 *   none      不听
 *
 * @param {object} t Trigger
 * @param {{allowed?:boolean, listenAll?:boolean, paused?:boolean}} policy
 */
export function strengthOf(t, policy = {}) {
  if (!t || !t.human) return "none";
  if (policy.paused) return "none";
  if (t.addressed === "direct" || t.addressed === "mention") return "explicit";
  if (policy.listenAll && policy.allowed !== false) return "inferred";
  return "none";
}

/**
 * 记一条处置：它去了哪儿、为什么没被接。
 * 只追加、不改写，跟 superagent 的 TriggerDisposition 一个思路：
 * 授权与处置都要留痕，不然吵到人之后没法回溯。
 *
 * @param {string} file  jsonl 路径
 * @param {object} rec   {triggerId, disposition:{filtered?, evalId?, decisionId?, fanout?, at}}
 * @param {object} [deps]  {appendFileSync} —— 允许注入，测试里换成内存实现
 */
export function appendDisposition(file, rec, deps = {}) {
  const fs = deps.fs ?? null;
  const line = JSON.stringify({ ...rec, at: rec.at ?? new Date().toISOString() }) + "\n";
  if (deps.append) { deps.append(line); return line; }
  if (fs) { fs.appendFileSync(file, line, "utf8"); return line; }
  return line;
}
