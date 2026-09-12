#!/usr/bin/env node
/**
 * 提醒调度入口 —— cron 每分钟调用（无参数即触发到期提醒）
 * 也支持手工管理：
 *   node scripts/reminders.mjs                      # 触发到期提醒（cron 用）
 *   node scripts/reminders.mjs list [--all]         # 列出提醒
 *   node scripts/reminders.mjs add <target> <时间> <内容> [--group] [--repeat N] [--until T]
 *   node scripts/reminders.mjs cancel <id|all>      # 取消提醒
 * 时间格式："2026-09-14 16:00"（本地）或 "+90m"/"+2h"/"+3d"
 */
import { addReminder, listReminders, cancelReminder, runDue, fmtTime } from "../lib/reminders.mjs";

const [cmd, ...rest] = process.argv.slice(2);

const flag = (name) => {
  const i = rest.indexOf(name);
  return i >= 0 ? rest[i + 1] : undefined;
};
const has = (name) => rest.includes(name);

function printList(items, all) {
  if (!items.length) { console.log(all ? "（无提醒）" : "（无待触发提醒）"); return; }
  for (const r of items) {
    const rep = r.repeatMinutes ? ` 每${r.repeatMinutes >= 1440 ? `${r.repeatMinutes / 1440}天` : `${r.repeatMinutes}分钟`}` : "";
    const end = r.until ? ` 至 ${fmtTime(r.until)}` : "";
    console.log(`${r.done ? "[已完成] " : "[待触发] "}${r.id}  ${fmtTime(r.fireAt)}${rep}${end}  → ${r.chat === "group" ? "群" : "私聊"} ${r.target}\n    ${r.text}`);
  }
}

try {
  if (!cmd) {
    const { fired, errors } = await runDue();
    if (fired) console.log(`[reminders] 已触发 ${fired} 条`);
    for (const e of errors) console.error(`[reminders] 发送失败 ${e}`);
    process.exit(0);
  }

  if (cmd === "list" || cmd === "ls") {
    printList(listReminders({ all: has("--all") }), has("--all"));
  } else if (cmd === "add") {
    const [target, at, text] = rest;
    const it = addReminder({
      target,
      at,
      text,
      chat: has("--group") ? "group" : "private",
      repeatMinutes: flag("--repeat") ? Number(flag("--repeat")) : undefined,
      until: flag("--until"),
    });
    console.log(`已添加提醒 ${it.id}：${fmtTime(it.fireAt)} → ${it.target}\n  ${it.text}`);
  } else if (cmd === "cancel" || cmd === "rm") {
    const r = cancelReminder(rest[0]);
    console.log(r.removed ? `已取消 ${r.removed} 条` : "未找到匹配的提醒");
  } else {
    console.error(`未知子命令: ${cmd}`);
    process.exit(1);
  }
} catch (e) {
  console.error(`[reminders] 出错: ${e?.message}`);
  process.exit(1);
}
