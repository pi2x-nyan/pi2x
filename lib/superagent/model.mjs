/**
 * 领域模型 —— 照着 dsh-superagent 的 docs/001–003 落到 PI2X 的形状上
 *
 * 概念对照（右边是我们的实现）：
 *   Source       qq / 文件监视 / 定时            → Trigger.source
 *   Thread       会话 + 引用链                    → Trigger.threadKey
 *   Trigger      一条进来的消息                    → lib/trigger.mjs
 *   Eval/Decision 要不要接、接成什么样              → policy.mjs + decisions
 *   Mandate      这次活的授权基底，不可变            → Ticket.mandate
 *   Ticket       一个工单（= 一次 run_task 的生命周期）
 *   Assignment   工单的一次执行（换成新 worker 就是新 assignment）
 *   Report       执行汇报：progress/waiting/ready/blocked/failed
 *   Attention    等人回答的问题
 *
 * 为什么要这一层：以前 run_task 只有一个 task 对象在内存里，跑完就散。
 * 于是「这条消息属于哪个任务」「它上次汇报到哪」「人在等什么」全都没有落点，
 * 重启即失忆。现在每个工单是可落盘、可查询、可续跑的实体。
 */

import { randomBytes } from "node:crypto";

export const TICKET_STATES = ["open", "ended"];
export const ASSIGNMENT_STATES = ["pending", "running", "ended"];
export const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];
export const END_BY = ["executor", "human", "policy"];
export const OUTCOMES = ["completed", "dropped", "stopped", "failed"];

export function newId(prefix) {
  return `${prefix}-${Date.now().toString(36)}-${randomBytes(3).toString("hex")}`;
}

export function isoNow() {
  return new Date().toISOString();
}

/** 工单：一个有授权依据的工作项 */
export function createTicket({ title, chatKey, threadKey, mandate, channel, id }) {
  const at = isoNow();
  return {
    id: id ?? newId("tkt"),
    title: String(title ?? "").slice(0, 120),
    chatKey,
    threadKey,
    /** 授权基底：谁、因为什么、什么强度。创建后不再改（只在新工单上产生新 mandate） */
    mandate,
    channel: channel ?? { chatType: "private", chatId: String(chatKey).split(":").pop() },
    createdAt: at,
    updatedAt: at,
    ended: null,
    attention: null,
    assignments: [],
    inputs: [],
    /** 影子工单：observe 模式下只记录、不执行 */
    shadow: !!mandate?.shadow,
  };
}

/** 新的一次执行 */
export function createAssignment({ id, note } = {}) {
  return {
    id: id ?? newId("asg"),
    state: "pending",
    createdAt: isoNow(),
    startedAt: null,
    endedAt: null,
    endedReason: null,
    note: note ?? null,
    report: null,
    /** 这轮执行占的槽位编号，结束时释放 */
    slot: null,
  };
}

export function startAssignment(a, slot = null) {
  a.state = "running";
  a.startedAt = isoNow();
  a.slot = slot;
  return a;
}

export function endAssignment(a, reason, report = null) {
  a.state = "ended";
  a.endedAt = isoNow();
  a.endedReason = reason ?? null;
  if (report) a.report = report;
  return a;
}

export function makeReport({ state = "progress", summary = "", needs = null }) {
  if (!REPORT_STATES.includes(state)) throw new Error(`未知 report state: ${state}`);
  return { state, summary: String(summary ?? ""), needs: needs ?? null, at: isoNow() };
}

export function latestAssignment(t) {
  return t.assignments.length ? t.assignments[t.assignments.length - 1] : null;
}

export function isLive(t) {
  return !!t && !t.ended;
}

/**
 * 阶段判定 —— 照 docs/003 那张表，从上往下第一条命中即止。
 * ended → delivery 失败 → 等人回答 → 等人验收 → 卡住/失败 → 排队 → idle → working
 */
export function ticketStage(t) {
  if (!t) return { stage: "ended" };
  if (t.ended) return { stage: "ended" };
  const a = latestAssignment(t);
  const report = a?.report?.state;
  if (t.attention) return { stage: "person", action: "answer" };
  if (report === "ready") return { stage: "person", action: "review" };
  if ((report === "blocked" || report === "failed") && waitsForPerson(t)) {
    return { stage: "person", action: report === "blocked" ? "blocked" : "failed" };
  }
  if (!a || a.state === "pending") return { stage: "working", action: "queued" };
  if (report === "waiting" || a.state === "ended") return { stage: "idle" };
  return { stage: "working" };
}

/** 卡住/失败之后，是否还没有人来接手（有新的真人输入就算被接手） */
export function waitsForPerson(t) {
  const a = latestAssignment(t);
  const at = a?.report?.at ?? "";
  return !t.inputs.some((i) => i.human && i.at >= at);
}

export function addInput(t, input) {
  t.inputs.push({ id: input.id ?? newId("inp"), at: input.at ?? isoNow(), ...input });
  t.updatedAt = isoNow();
  return t;
}

export function setAttention(t, question, triggerId) {
  t.attention = question ? { question: String(question), triggerId: triggerId ?? null, at: isoNow() } : null;
  t.updatedAt = isoNow();
  return t;
}

export function endTicket(t, { by = "executor", outcome = "completed", reason = null } = {}) {
  t.ended = { at: isoNow(), by, outcome, reason };
  t.attention = null;
  t.updatedAt = isoNow();
  return t;
}

/** 简洁视图，给模型/面板看，不带内部冗余 */
export function ticketView(t) {
  const a = latestAssignment(t);
  const st = ticketStage(t);
  return {
    id: t.id,
    title: t.title,
    chatKey: t.chatKey,
    shadow: !!t.shadow,
    stage: st.stage,
    action: st.action ?? null,
    report: a?.report?.state ?? null,
    needs: a?.report?.needs ?? t.attention?.question ?? null,
    summary: a?.report?.summary ?? null,
    inputs: t.inputs.length,
    created: t.createdAt,
    ended: t.ended?.outcome ?? null,
  };
}
