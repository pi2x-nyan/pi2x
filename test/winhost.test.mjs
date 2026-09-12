import test from "node:test";
import assert from "node:assert/strict";

import { WinHostResolver } from "../lib/winhost.mjs";

/** 构造一个可控的假 fetch：按 host 决定成功/失败/挂起 */
function fakeFetch(behavior, calls = []) {
  return async (url, init = {}) => {
    const m = /^http:\/\/([^:]+):(\d+)(\/.*)$/.exec(url);
    const host = m?.[1] ?? "?";
    const pathname = m?.[3] ?? url;
    calls.push({ host, pathname, hasSignal: !!init.signal });
    const b = behavior(host, pathname) ?? "ok";
    if (b === "reject") throw new Error(`ECONNREFUSED ${host}`);
    if (b === "hang") {
      // 模拟「挂起」：等信号中止（若没有信号则永不返回，测试里由超时兜住）
      await new Promise((_, rej) => {
        if (init.signal) init.signal.addEventListener("abort", () => rej(new Error("aborted")));
      });
    }
    if (b === "500") return { ok: false, status: 500, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ host, pathname }) };
  };
}

const CFG = {
  host: "<OVERLAY_IP>",
  fallbackHost: "<LAN_IP>",
  port: 8123,
  token: "tok",
  probeTimeoutMs: 50,
};

const silent = { log() {}, error() {} };

test("candidates：去重、去空、保序", () => {
  const r = new WinHostResolver({ host: "a", fallbackHost: "b", fallbackHosts: ["c", "a", null, ""] }, { fetchImpl: fakeFetch(() => "ok"), logger: silent });
  assert.deepEqual(r.candidates, ["a", "b", "c"]);
});

test("active()：未探测时为首选地址", () => {
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "ok"), logger: silent });
  assert.equal(r.active(), "<OVERLAY_IP>");
});

test("pick()：首选不可达时自动回退备用地址", async () => {
  const calls = [];
  const r = new WinHostResolver(CFG, {
    fetchImpl: fakeFetch((h) => (h === "<OVERLAY_IP>" ? "reject" : "ok"), calls),
    logger: silent,
  });
  const h = await r.pick();
  assert.equal(h, "<LAN_IP>");
  assert.equal(r.active(), "<LAN_IP>");
  assert.ok(calls.some((c) => c.host === "<OVERLAY_IP>"), "应探测过首选");
});

test("pick()：全部不可达 → null（不抛错）", async () => {
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "reject"), logger: silent });
  assert.equal(await r.pick(), null);
});

test("pick()：未配置 host 时抛错", async () => {
  const r = new WinHostResolver({}, { fetchImpl: fakeFetch(() => "ok"), logger: silent });
  await assert.rejects(() => r.pick(), /未配置 host/);
});

test("fetch()：TTL 内复用探测结果，不重复 ping", async () => {
  const calls = [];
  const now = 1_000_000;
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "ok", calls), logger: silent, now: () => now });
  await r.fetch("/exec", { method: "POST" });
  const pings1 = calls.filter((c) => c.pathname === "/ping").length;
  assert.equal(pings1, 1, "首次应探测一次");
  calls.length = 0;
  await r.fetch("/exec", { method: "POST" });
  assert.equal(calls.filter((c) => c.pathname === "/ping").length, 0, "TTL 内不应再探测");
  assert.equal(calls.length, 1, "只发真正的业务请求");
});

test("fetch()：TTL 过期后重新探测", async () => {
  const calls = [];
  let now = 1_000_000;
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "ok", calls), logger: silent, now: () => now });
  await r.fetch("/exec");
  now += 21000; // 超过 20s TTL
  calls.length = 0;
  await r.fetch("/exec");
  assert.equal(calls.filter((c) => c.pathname === "/ping").length, 1, "过期后应重新探测");
});

test("fetch()：两个地址全挂 → 快速失败，且只探测不硬等", async () => {
  const calls = [];
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "reject", calls), logger: silent });
  await assert.rejects(() => r.fetch("/exec"), /不可达/);
  // 双探测（每地址各一次 ×2 轮）= 4 次 ping，然后立刻抛错，不发业务请求
  const pings = calls.filter((c) => c.pathname === "/ping").length;
  assert.equal(pings, 4, `应为「双探测 ×2 地址」= 4 次，实测 ${pings}`);
  assert.equal(calls.filter((c) => c.pathname === "/exec").length, 0, "全挂时不应发业务请求");
});

test("fetch()：首选发业务请求失败 → 换备用地址重试", async () => {
  const calls = [];
  const r = new WinHostResolver(CFG, {
    fetchImpl: fakeFetch((h, p) => (h === "<OVERLAY_IP>" && p === "/exec" ? "reject" : "ok"), calls),
    logger: silent,
  });
  const resp = await r.fetch("/exec");
  assert.equal(resp.status, 200);
  assert.equal(r.active(), "<LAN_IP>", "失败后应切到备用并缓存");
});

test("fetch()：每次尝试都带独立超时信号（防止备用跳被掐掉）", async () => {
  const calls = [];
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "ok", calls), logger: silent });
  await r.fetch("/exec", { timeoutMs: 5000 });
  const biz = calls.find((c) => c.pathname === "/exec");
  assert.ok(biz?.hasSignal, "业务请求必须带中止信号");
});

test("fetch()：外部 signal 已中止 → 立即抛错，不再尝试备用地址", async () => {
  const calls = [];
  const ac = new AbortController();
  ac.abort();
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "reject", calls), logger: silent });
  await assert.rejects(() => r.fetch("/exec", { signal: ac.signal }));
  const tried = new Set(calls.filter((c) => c.pathname === "/exec").map((c) => c.host));
  assert.ok(tried.size <= 1, `外部中止后不该继续试备用地址，实测试了 ${[...tried].join(",")}`);
});

test("json()：非 2xx 抛错并带状态码", async () => {
  // ping 正常，但业务路径返回 500
  const r = new WinHostResolver(CFG, {
    fetchImpl: fakeFetch((_h, p) => (p === "/ping" ? "ok" : "500")),
    logger: silent,
  });
  await assert.rejects(() => r.json("/exec"), /HTTP 500/);
});

test("invalidate()：手工失效后重新探测", async () => {
  const calls = [];
  const r = new WinHostResolver(CFG, { fetchImpl: fakeFetch(() => "ok", calls), logger: silent });
  await r.pick();
  r.invalidate();
  assert.equal(r.active(), "<OVERLAY_IP>", "失效后 active 回落首选");
  calls.length = 0;
  await r.pick();
  assert.ok(calls.filter((c) => c.pathname === "/ping").length >= 1, "应重新探测");
});

test("端口与鉴权头拼接正确", async () => {
  const seen = [];
  const r = new WinHostResolver(CFG, {
    fetchImpl: async (url, init) => {
      seen.push({ url, auth: init.headers?.Authorization });
      return { ok: true, status: 200, json: async () => ({}) };
    },
    logger: silent,
  });
  // 鉴权头由调用方提供（探测用的是配置里的 token）
  await r.fetch("/exec", { headers: { Authorization: `Bearer ${CFG.token}` } });
  const biz = seen.find((s) => s.url.includes("/exec"));
  assert.ok(biz.url.startsWith("http://<OVERLAY_IP>:8123/exec"), biz.url);
  assert.equal(biz.auth, "Bearer tok");
  const ping = seen.find((s) => s.url.includes("/ping"));
  assert.equal(ping.auth, "Bearer tok", "探测也应带鉴权头");
});
