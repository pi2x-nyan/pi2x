import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { log, createLogger, withTurn, currentTurn, setLevel, getLevel } from "../lib/log.mjs";

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
  assert.match(out, /^\d{2}:\d{2}:\d{2}\.\d{3} /, "应以本地时间戳开头");
  assert.match(out, /\[info\]/);
  assert.match(out, /\[myscope\]/);
  assert.match(out, /hello/);
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
