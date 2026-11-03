/**
 * ticket-stage —— 子任务的「阶段判定」与「报告结构」
 *
 * 借鉴自 DeepSeek dsh-superagent（MIT，2026-10-31）的 docs/003 Execution：
 * 每个工单只有一个 stage，判定按表格从上往下、第一条命中即止。
 *   person / delivery  输入投递失败，重试中
 *   person / answer    有一个待答复的问题
 *   person / review    结果 ready，等人验收
 *   person / blocked   卡住，等人解锁
 *   person / failed    失败，等人决定下一步
 *   working / queued   排队
 *   idle               空转，等触发
 *   working            在干
 *
 * 我们这边的差别：PI2X 的子任务是一次性的（run_task），没有「等下一次触发」的
 * idle 态，所以这里只保留 person / working / ended 三类，但把 person 的
 * 五个 action 全留下 —— 「卡在人」和「在干活」必须分开，不然通知永远是一团糊。
 *
 * 为什么要它：以前子任务只有 running / done / failed / aborted 四个扁平状态，
 * 主 agent 收到的通知长一个样，看不出「要不要我处理」。判定收进这里之后，
 * 通知可以按 stage 说话：卡人的说得具体，干完活的只报结论。
 */

/** 报告状态，按 dsh-superagent 的 ReportState 取子集 */
export const REPORT_STATES = ["progress", "waiting", "ready", "blocked", "failed", "dropped"];

/**
 * 把 PI2X 的子任务结果映射成一个 stage。
 *
 * @param {object} t
 * @param {string} [t.status]     pending|running|done|failed|aborted
 * @param {boolean} [t.timedOut]  撞了超时上限
 * @param {string} [t.question]   子任务显式提出的、需要人回答的问题
 * @param {string} [t.error]
 * @returns {{stage:"person"|"working"|"ended", action?:string, waitsForPerson:boolean}}
 */
export function classifyStage(t = {}) {
  const status = String(t.status ?? "pending");
  if (status === "running" || status === "pending") {
    return { stage: "working", action: status === "pending" ? "queued" : undefined, waitsForPerson: false };
  }
  // 已经定性为终态
  if (status === "done") {
    if (t.question) return { stage: "person", action: "answer", waitsForPerson: true };
    return { stage: "person", action: "review", waitsForPerson: true };
  }
  if (status === "aborted") return { stage: "person", action: "failed", waitsForPerson: true };
  if (t.timedOut) return { stage: "person", action: "blocked", waitsForPerson: true };
  return { stage: "person", action: "failed", waitsForPerson: true };
}

/**
 * 报告：三段式，强制回答「做了什么 / 结果 / 需要你什么」。
 * 空的那一段不占地方 —— 宁缺毋滥。
 *
 * @param {object} t 同 classifyStage，另加 t.reply、t.toolLog
 * @returns {{state:string, summary:string, needs?:string}}
 */
export function buildReport(t = {}) {
  const st = classifyStage(t);
  const reply = String(t.reply ?? "").trim();
  const tools = Array.isArray(t.toolLog) ? t.toolLog.length : 0;
  const err = String(t.error ?? "").trim();

  let state = "progress";
  if (st.action === "review") state = "ready";
  else if (st.action === "answer") state = "waiting";
  else if (st.action === "blocked") state = "blocked";
  else if (st.action === "failed") state = "failed";
  else if (st.stage === "working") state = "progress";

  const parts = [];
  if (reply) parts.push(reply);
  else if (tools > 0) parts.push(`没有正文输出，但执行了 ${tools} 次工具调用`);
  else parts.push("没有正文输出，也没有任何工具调用");

  let needs;
  if (st.action === "answer") needs = String(t.question);
  else if (st.action === "blocked") needs = err ? `被卡住：${err}` : "被卡住（超时），需要决定是否重派";
  else if (st.action === "failed") needs = err ? `失败：${err}` : "已中止/失败，需要决定下一步";
  else if (st.action === "review") needs = "结果已就绪，等你验收";

  return { state, summary: parts.join("\n"), needs };
}

/** 给人看的一行阶段标签 */
export function stageLabel(st) {
  if (!st) return "未知";
  if (st.stage === "ended") return "已结束";
  if (st.stage === "working") return st.action === "queued" ? "排队中" : "执行中";
  const map = {
    delivery: "投递失败·等人",
    answer: "等你回答",
    review: "等你验收",
    blocked: "被卡住·等人",
    failed: "失败·等人",
  };
  return `待处理·${map[st.action] ?? st.action}`;
}

/**
 * 要不要为这次结果打扰人。
 * 反例（不打扰）：还在 working；已经有人处理过的重复通知。
 * 正例：等验收、等回答、卡住、失败。
 */
export function shouldNotify(st) {
  return !!st && st.stage === "person";
}
