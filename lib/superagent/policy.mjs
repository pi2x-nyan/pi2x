/**
 * 授权闸门 —— 确定性代码，不交给提示词
 *
 * 这是 dsh-superagent 最硬的一条设计（docs/002 + src/policy.ts 的 gate()）：
 *   消息、评论、引用的文档都只是「输入」，它们改不了权限。
 *   谁能触发、触发出多大强度的授权，由这张表算，模型说了不算。
 *
 * 我们这边的三档模式，对应他们的 off / observe / auto：
 *   off      只处理真人明确对我说的（私聊、@我）
 *   observe  额外记录「按规则本来会接的活」，但不执行（影子工单）
 *   auto     observe 记录的也真的派下去
 *
 * 强度只有两级，不搞更多花样：
 *   explicit  人明确请求（私聊直发 / 群里 @ / 名单内的人对我说话）
 *   inferred  规则允许去听（群里没 @，但团队放开了整条会话）
 */

export const MODES = ["off", "observe", "auto"];
export const STRENGTH = { none: 0, inferred: 1, explicit: 2 };

/**
 * 闸门：给一个 Trigger 和当前策略，判定「能不能接、以什么强度接」。
 *
 * @param {object} trigger  lib/trigger.mjs 造出来的
 * @param {object} policy
 * @param {"off"|"observe"|"auto"} policy.mode
 * @param {boolean} [policy.paused]      全局暂停：一律不接
 * @param {Set<string>|string[]} [policy.allowedUsers]
 * @param {Set<string>|string[]} [policy.listenAllChats]  允许「听整条会话」的 chatKey
 * @param {boolean} [policy.allowBots]
 * @returns {{admissible:boolean, strength:"none"|"inferred"|"explicit", shadow?:boolean, reason:string}}
 */
export function gate(trigger, policy = {}) {
  const mode = MODES.includes(policy.mode) ? policy.mode : "off";
  if (policy.paused) return deny("paused");
  if (!trigger) return deny("no_trigger");
  if (!trigger.human && !policy.allowBots) return deny("bot");

  const allowed = toSet(policy.allowedUsers);
  const isAllowed = allowed.size === 0 ? true : allowed.has(String(trigger.actor?.id ?? ""));
  if (!isAllowed) return deny("not_allowed");

  // 明确指向我：一直放行，observe 模式也照样执行（是人在要，不是自作主张）
  if (trigger.addressed === "direct" || trigger.addressed === "mention") {
    return { admissible: true, strength: "explicit", reason: "addressed" };
  }

  // 没指向我的：取决于团队是否放开了这条会话
  const listen = toSet(policy.listenAllChats);
  const chatKey = `qq:${trigger.channel?.chatType ?? "private"}:${trigger.channel?.chatId ?? ""}`;
  const listened = listen.size === 0 ? false : listen.has(chatKey) || listen.has("*");
  if (!listened) return deny("not_addressed");

  if (mode === "off") return deny("mode_off");
  // observe：记录一个影子工单，不执行
  if (mode === "observe") return { admissible: true, strength: "inferred", shadow: true, reason: "observe" };
  return { admissible: true, strength: "inferred", reason: "admission" };
}

function deny(reason) {
  return { admissible: false, strength: "none", reason };
}

function toSet(v) {
  if (!v) return new Set();
  if (v instanceof Set) return v;
  if (Array.isArray(v)) return new Set(v.map(String));
  return new Set();
}

/** 造授权基底。不可变：工单建好之后没人能改它，revalidate 只做「还成不成立」的判断 */
export function makeMandate(trigger, verdict, { mode = "off" } = {}) {
  return Object.freeze({
    strength: verdict.strength,
    reason: verdict.reason,
    mode,
    shadow: !!verdict.shadow,
    via: trigger.addressed === "direct" ? "direct" : trigger.addressed === "mention" ? "mention" : "rule",
    actor: { id: String(trigger.actor?.id ?? ""), name: trigger.actor?.name ?? null },
    threadKey: trigger.threadKey,
    triggerId: trigger.id,
    at: new Date().toISOString(),
  });
}

/**
 * 复查：工单还在跑的时候，原来的授权是否仍然成立。
 * 场景：人被移出白名单、会话被停止监听、全局暂停 —— 这些都要能让在跑的活收手。
 */
export function revalidate(mandate, policy = {}) {
  if (!mandate) return false;
  if (policy.paused) return false;
  if (mandate.strength === "explicit") {
    const allowed = toSet(policy.allowedUsers);
    if (allowed.size === 0) return true;
    return allowed.has(String(mandate.actor?.id ?? ""));
  }
  if (mandate.strength === "inferred") {
    const listen = toSet(policy.listenAllChats);
    const chatKey = `qq:${(mandate.threadKey ?? "").split(":")[1] ?? "private"}:${(mandate.threadKey ?? "").split(":")[2] ?? ""}`;
    return listen.has(chatKey) || listen.has("*");
  }
  return false;
}

/**
 * 影子工单要不要「转正」。observe 跑一段之后，把当时本来会接的活列出来给人看，
 * 由人决定放不放权 —— 这一步以前完全没有，所以之前的主动行为等于直接 auto。
 */
export function promotionCandidates(store, { limit = 10 } = {}) {
  return store
    .all()
    .filter((t) => t.shadow && !t.ended)
    .slice(-limit)
    .map((t) => ({ id: t.id, title: t.title, createdAt: t.createdAt, chatKey: t.chatKey }));
}
