import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { log, createLogger, withTurn, currentTurn, setLevel, getLevel, LOG_HEAD } from "../lib/log.mjs";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/** 捕获 stdout 写入 */
function capture(fn) {
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    fn();
  } finally {
    process.stdout.write = orig;
  }
  return chunks.join("");
}

test("createLogger：无 scope 时返回根记录器（同一实例）", () => {
  assert.equal(createLogger(), log);
  assert.equal(createLogger(""), log);
  assert.notEqual(createLogger("x"), log);
});

test("级别过滤：debug 默认不输出，info/warn/error 输出", () => {
  const prev = getLevel();
  setLevel("info");
  const l = createLogger("t");
  const out = capture(() => {
    l.debug("D");
    l.info("I");
    l.warn("W");
    l.error("E");
  });
  assert.ok(!out.includes("D"));
  assert.ok(out.includes("I"));
  assert.ok(out.includes("W"));
  assert.ok(out.includes("E"));
  setLevel(prev);
});

test("setLevel('silent') 可完全静音", () => {
  const prev = getLevel();
  setLevel("silent");
  const out = capture(() => createLogger("t").error("不该出现"));
  assert.equal(out, "");
  setLevel(prev);
});

test("输出包含时间戳、级别、scope", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("myscope").info("hello"));
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /, "应以带日期的本地时间戳开头");
  assert.match(out, /\[info\]/);
  assert.match(out, /\[myscope\]/);
  assert.match(out, /hello/);
  setLevel(prev);
});

test("时间戳带日期，且与当前本地日期一致（防止跨天日志歧义）", () => {
  const prev = getLevel();
  setLevel("info");
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const today = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  const out = capture(() => createLogger("t").info("x"));
  assert.ok(
    out.startsWith(today),
    `时间戳应以今天的日期 ${today} 开头，实际: ${out.slice(0, 30)}`
  );
  setLevel(prev);
});

test("console.log 兼容别名：createLogger(...).log() 也带时间戳与 scope", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("asm").log("[dbg-submit] settle"));
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /, "别名输出也必须有完整时间戳");
  assert.match(out, /\[asm\]/, "别名输出应带 scope");
  assert.match(out, /\[dbg-submit\] settle/);
  setLevel(prev);
});

test("根记录器 log.log() 同样带时间戳（不依赖 scope）", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => log.log("裸通道"));
  assert.match(out, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} /);
  assert.match(out, /裸通道/);
  setLevel(prev);
});

test("withTurn：同步作用域内日志带轮次号", () => {
  const prev = getLevel();
  setLevel("info");
  const l = createLogger("t");
  const out = capture(() => {
    withTurn("private:123", () => l.info("inside"));
  });
  assert.match(out, /\[t\d+ private:123\]/);
  setLevel(prev);
});

test("withTurn：异步链内自动继承轮次号（这是它的核心价值）", async () => {
  const prev = getLevel();
  setLevel("info");
  const l = createLogger("t");
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    await withTurn("group:999", async () => {
      l.info("第一层");
      await new Promise((r) => setTimeout(r, 5));
      l.info("await 之后");
      await Promise.resolve().then(() => l.info("微任务里"));
    });
  } finally {
    process.stdout.write = orig;
  }
  const out = chunks.join("");
  const hits = out.split("\n").filter((x) => x.includes("group:999"));
  assert.equal(hits.length, 3, `异步链内 3 条日志都应带轮次号，实测 ${hits.length}`);
  setLevel(prev);
});

test("withTurn：不同轮次号互不串味；外部调用无轮次号", async () => {
  const prev = getLevel();
  setLevel("info");
  const l = createLogger("t");
  const seen = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    seen.push(String(c));
    return true;
  };
  try {
    withTurn("A", () => l.info("a1"));
    withTurn("B", () => l.info("b1"));
    l.info("none");
  } finally {
    process.stdout.write = orig;
  }
  const out = seen.join("");
  const lines = out.split("\n").filter(Boolean);
  assert.ok(lines.find((x) => x.includes("a1")).includes(" A"));
  assert.ok(lines.find((x) => x.includes("b1")).includes(" B"));
  assert.doesNotMatch(lines.find((x) => x.includes("none")), /\[t\d+ /, "无轮次时不该出现轮次标签");
  setLevel(prev);
});

test("currentTurn：作用域外为 null，作用域内可读", () => {
  assert.equal(currentTurn(), null);
  withTurn("k", () => {
    assert.equal(currentTurn().chatKey, "k");
    assert.match(currentTurn().id, /^t\d+$/);
  });
  assert.equal(currentTurn(), null);
});

test("time()：返回 stop，stop 返回毫秒数并输出", () => {
  const prev = getLevel();
  setLevel("info");
  const l = createLogger("t");
  const stop = l.time("干活");
  const out = capture(() => {});
  let ms;
  const chunks = [];
  const orig = process.stdout.write.bind(process.stdout);
  process.stdout.write = (c) => {
    chunks.push(String(c));
    return true;
  };
  try {
    ms = stop("附带说明");
  } finally {
    process.stdout.write = orig;
  }
  assert.equal(typeof ms, "number");
  assert.ok(ms >= 0);
  const s = chunks.join("");
  assert.match(s, /干活 用时 \d+ms · 附带说明/);
  setLevel(prev);
});

test("Error 与对象参数被正确序列化", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("t").error(new Error("炸了"), { code: 42 }));
  assert.match(out, /Error: 炸了/);
  assert.match(out, /\{"code":42\}/);
  setLevel(prev);
});

test("循环引用对象不会抛异常（回退为 String）", () => {
  const prev = getLevel();
  setLevel("info");
  const cyc = {};
  cyc.self = cyc;
  assert.doesNotThrow(() => capture(() => createLogger("t").info(cyc)));
  setLevel(prev);
});

test("LOG_FORMAT=json 输出合法 JSON Lines（子进程验证）", () => {
  const script = `
    const { createLogger } = await import(${JSON.stringify(path.join(ROOT, "lib", "log.mjs"))});
    createLogger("js").info("结构化消息", { n: 1 });
  `;
  const out = execFileSync(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, LOG_FORMAT: "json", LOG_LEVEL: "info" },
    encoding: "utf8",
  }).trim();
  const obj = JSON.parse(out);
  assert.equal(obj.level, "info");
  assert.equal(obj.scope, "js");
  assert.equal(obj.msg, "结构化消息 {\"n\":1}");
  assert.ok(obj.ts, "应有 ISO 时间戳");
  assert.equal(obj.turn, null);
});

// ── 日志头（区分「日志」与「用户发言」）──────────────────────────────

test("每一行日志都带 [LOG] 头（防止形似对话的日志被当成用户发言）", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("recv").info("private:123 <某人>: 注意语气"));
  assert.ok(out.startsWith(`${out.slice(0, 23)}${LOG_HEAD}`) || out.includes(LOG_HEAD), "必须含日志头");
  assert.match(out, /\[LOG\]\[info\]\[recv\]/, "日志头应紧跟在时间戳后");
  setLevel(prev);
});

test("日志头常量就是 [LOG]（便于静态识别）", () => {
  assert.equal(LOG_HEAD, "[LOG]");
});

test("多行日志：每一行都带完整头部（续行不再是无头裸文本）", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("pi").info("新会话 a\n   权限: x, y\n   备注: z"));
  const lines = out.split("\n").filter(Boolean);
  assert.equal(lines.length, 3, `应输出 3 行，实际 ${lines.length}`);
  for (const l of lines) {
    assert.match(l, /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}\.\d{3} \[LOG\]\[info\]\[pi\] /, `续行也要带头部: ${l}`);
  }
  assert.match(lines[1], /^.*╎ /, "续行应用 ╎ 标出");
  assert.match(lines[1], /权限: x, y/);
  setLevel(prev);
});

test("单行日志不会被拆（不引入多余换行）", () => {
  const prev = getLevel();
  setLevel("info");
  const out = capture(() => createLogger("t").info("就一行"));
  assert.equal(out.split("\n").filter(Boolean).length, 1);
  setLevel(prev);
});
