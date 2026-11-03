/**
 * 图片进入上下文的回归测试。
 *
 * 【被锁定的故障】(2026-10-21)
 * 群里 Rekjo 转发了一整个聊天记录（6 条），其中最前面一条是图片，
 * bot 回复「我这边收到的只有 [图片] 这个占位符，图本身没进到我的上下文」。
 *
 * 根因两条独立：
 *  1. extractImages() 只扫顶层 `type === "image"`，转发消息里的图在
 *     get_forward_msg 返回的子结构里，从未被抽出来；
 *  2. renderForward() 把图渲成 "[图片]" 占位符就完事，图本身没随文本走。
 *
 * 这里覆盖三条通路：顶层图、引用里的图、合并转发里的图。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { QQBridge } from "../lib/qqbridge.mjs";

test("extractImages：只取顶层图（保持原语义）", () => {
  const msg = [
    { type: "text", data: { text: "hi" } },
    { type: "image", data: { file: "a.jpg", url: "http://x/a.jpg" } },
  ];
  const r = QQBridge.extractImages(msg);
  assert.equal(r.length, 1);
  assert.equal(r[0].file, "a.jpg");
});

test("collectImageRefs：能钻进嵌套结构找到图", () => {
  const node = {
    type: "reply",
    data: {
      message: [
        { type: "text", data: { text: "看这个" } },
        { type: "image", data: { file: "b.jpg" } },
      ],
    },
  };
  const r = QQBridge.collectImageRefs(node);
  assert.equal(r.length, 1, "嵌套在 reply.data.message 里的图没被找到");
  assert.equal(r[0].file, "b.jpg");
});

test("collectImageRefs：顶层数组也能用，且不重复计", () => {
  const msg = [{ type: "image", data: { file: "c.jpg" } }];
  assert.equal(QQBridge.collectImageRefs(msg).length, 1);
});

test("collectImageRefs：深度上限防环", () => {
  let deep = { type: "text", data: {} };
  for (let i = 0; i < 20; i++) deep = { type: "x", data: { message: [deep] } };
  // 只是确保不栈溢出、不卡死
  assert.doesNotThrow(() => QQBridge.collectImageRefs(deep));
});

test("parseForwardMessages：每条带出自己的 images", () => {
  const res = {
    messages: [
      { sender: { nickname: "Rekjo" }, message: [{ type: "image", data: { file: "p1.jpg" } }] },
      { sender: { nickname: "Rekjo" }, message: [{ type: "text", data: { text: "@PI2X" } }] },
      { sender: { nickname: "PI2X" }, message: [{ type: "text", data: { text: "喵？" } }] },
    ],
  };
  const items = QQBridge.parseForwardMessages(res);
  assert.equal(items.length, 3);
  assert.equal(items[0].images.length, 1, "第 1 条的图没被抽出来");
  assert.equal(items[0].images[0].file, "p1.jpg");
  assert.equal(items[1].images.length, 0);
});

test("renderForward：有图时打 <图片 N> 标号，与 images 顺序对应", () => {
  const items = [
    { name: "A", text: "[图片]", images: [{ file: "1.jpg" }] },
    { name: "B", text: "纯文本", images: [] },
    { name: "C", text: "[图片] [图片]", images: [{ file: "2.jpg" }, { file: "3.jpg" }] },
  ];
  const out = QQBridge.renderForward(items);
  assert.match(out, /〔第1条〕A: \[图片\] <图片 1>/);
  assert.match(out, /〔第3条〕C: \[图片\] \[图片\] <图片 2> <图片 3>/);
  assert.doesNotMatch(out, /〔第2条〕B: 纯文本 <图片/, "没图的条目不该有标号");
});

test("renderForward：无图时行为与改前一致", () => {
  const out = QQBridge.renderForward([{ name: "X", text: "hello" }]);
  assert.equal(out, "〔转发消息 共 1 条〕\n〔第1条〕X: hello");
});
