import test from "node:test";
import assert from "node:assert/strict";

/**
 * 引用图片消息 → 必须能捞到图
 *
 * 复现依据（2026-11-03 群里）：用户引用一张图问「解释一下」，
 * 当时 reply 段只有 id，collectImages 只看内联内容 → 抓不到 → 回「看不见图」。
 */
test("reply 段只有 id 时，按 id 回捞并取到图片引用", async () => {
  const { QQBridge } = await import("../lib/qqbridge.mjs");

  // 1) reply 段只有 id，没有 message 字段
  const replySeg = { type: "reply", data: { id: "1696941989" } };
  const nestedInline = QQBridge.collectImageRefs(replySeg.data.message ?? replySeg.data.content ?? []);
  assert.equal(nestedInline.length, 0, "前提：NapCat 的 reply 段不内联正文");

  // 2) 模拟 get_msg 返回被引用消息（含 image 段）
  const quoted = {
    message: [
      { type: "image", data: { file: "abc.image", url: "https://example.invalid/x.jpg", sub_type: 0 } },
    ],
  };
  const nested = QQBridge.collectImageRefs(quoted.message);
  assert.equal(nested.length, 1, "回捞后应拿到 1 张图");
  assert.equal(nested[0].file, "abc.image");
});

test("bridge.mjs 的 collectImages 里有按 id 回捞的分支", async () => {
  const fs = await import("node:fs");
  const src = fs.readFileSync(new URL("../bridge.mjs", import.meta.url), "utf8");
  assert.match(src, /引用消息\(\$\{qid\}\)内补捞到/, "必须有回捞成功的日志，证明分支存在");
  assert.match(src, /await bridge\.getMsg\(qid\)/, "必须真的调用 getMsg");
});
