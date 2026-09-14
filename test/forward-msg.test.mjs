/**
 * 合并转发（forward）支持回归测试。
 *
 * 【背景：合并转发曾经是"黑洞"】
 * OneBot11 里合并转发只给一个 id，正文要用 get_forward_msg 另拉。
 * 改动前 extractText 走兜底分支，把整段压成 `[forward]`：
 *   · 上层既不知道有转发、也拿不到 id → 正文永久丢失
 *   · 更糟的是 `[forward]` 不含实际文字，bridge 里 `if (!rawText) return` 那道闸
 *     会把整个事件丢掉，连日志都只留一句 `[recv] …: [forward]`
 * 现在 extractText 产出 `[转发 id:xxx]` 作为取件凭据，bridge 再据此取回并渲染。
 *
 * 下面的示例结构取自真实抓包（NapCat 实测），不是凭想象构造。
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { QQBridge } from "../lib/qqbridge.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const BRIDGE_SRC = fs.readFileSync(path.join(ROOT, "bridge.mjs"), "utf8");

// ── extractText：产出取件凭据 ─────────────────────────────────────────

test("extractText：forward 段产出 `[转发 id:xxx]`（不再是空标记 [forward]）", () => {
  // 实测 NapCat 的 forward 段就只有这一个字段
  const msg = [{ type: "forward", data: { id: "7684468158414712715" } }];
  const t = QQBridge.extractText(msg);
  assert.equal(t, "[转发 id:7684468158414712715]");
  assert.match(t, /id:/, "必须带上 id，否则上层无从拉取正文");
  assert.notEqual(t, "[forward]", "退回空标记 = 正文永久丢失");
});

test("extractText：forward 段缺 id 时不崩，给出降级标记", () => {
  assert.equal(QQBridge.extractText([{ type: "forward", data: {} }]), "[转发]");
  assert.equal(QQBridge.extractText([{ type: "forward" }]), "[转发]");
});

test("extractText：json/xml 段里的 resId 能被抠出来", () => {
  const jsonSeg = [{ type: "json", data: { data: '{"app":"com.tencent.multimsg","meta":{"detail":{"resid":"ABC123"}}}' } }];
  assert.equal(QQBridge.extractText(jsonSeg), "[转发 id:ABC123]");
  // 抠不到时保持原标记，不要假装是转发
  assert.equal(QQBridge.extractText([{ type: "json", data: { data: '{"app":"other"}' } }]), "[json]");
});

test("extractText：普通段不受影响（回归）", () => {
  assert.equal(QQBridge.extractText([{ type: "text", data: { text: "你好" } }]), "你好");
  assert.equal(QQBridge.extractText([{ type: "image", data: { file: "x" } }]), "[图片]");
  assert.equal(QQBridge.extractText([{ type: "face", data: { id: 1 } }]), "[表情]");
  assert.equal(QQBridge.extractText([{ type: "at", data: { qq: "123" } }]), "@123");
});

// ── parseForwardMessages：兼容多种返回结构 ────────────────────────────

/** 真实抓包的形状（裁到 2 条，去掉超长正文） */
const REAL_SHAPE = {
  status: "ok",
  retcode: 0,
  data: {
    messages: [
      {
        self_id: 1000000001, user_id: 1094950020, time: 1788684151, message_id: 1253819764,
        sender: { user_id: 1094950020, nickname: "小灰灰", card: "" },
        message: [{ type: "text", data: { text: "方向二：短视频平台上的国家安全科普" } }],
      },
      {
        self_id: 1000000001, user_id: 1234, time: 1788684200, message_id: 1253819800,
        sender: { user_id: 1234, nickname: "故梦", card: "" },
        message: [{ type: "text", data: { text: "那各位挑选一下吧" } }],
      },
    ],
  },
};

test("parseForwardMessages：解析真实 NapCat 返回结构", () => {
  const items = QQBridge.parseForwardMessages(REAL_SHAPE);
  assert.equal(items.length, 2);
  assert.equal(items[0].name, "小灰灰");
  assert.equal(items[0].text, "方向二：短视频平台上的国家安全科普");
  assert.equal(items[1].name, "故梦");
  assert.equal(items[1].text, "那各位挑选一下吧");
});

test("parseForwardMessages：兼容 { data: [...] } / 裸数组 / {messages}", () => {
  const one = { sender: { nickname: "A" }, message: [{ type: "text", data: { text: "x" } }] };
  assert.equal(QQBridge.parseForwardMessages({ messages: [one] }).length, 1);
  assert.equal(QQBridge.parseForwardMessages({ data: { messages: [one] } }).length, 1);
  assert.equal(QQBridge.parseForwardMessages({ data: [one] }).length, 1);
  assert.equal(QQBridge.parseForwardMessages([one]).length, 1);
});

test("parseForwardMessages：发送者优先用群名片 card，其次 nickname，再退 user_id", () => {
  const mk = (sd) => ({ messages: [{ sender: sd, message: [{ type: "text", data: { text: "t" } }] }] });
  assert.equal(QQBridge.parseForwardMessages(mk({ card: "群名片", nickname: "昵称", user_id: 1 }))[0].name, "群名片");
  assert.equal(QQBridge.parseForwardMessages(mk({ card: "", nickname: "昵称", user_id: 1 }))[0].name, "昵称");
  assert.equal(QQBridge.parseForwardMessages(mk({ user_id: 999 }))[0].name, "999");
  assert.equal(QQBridge.parseForwardMessages(mk({}))[0].name, "未知");
});

test("parseForwardMessages：空/异常输入不崩", () => {
  for (const v of [null, undefined, {}, { data: {} }, { messages: [] }, { data: { messages: null } }]) {
    assert.deepEqual(QQBridge.parseForwardMessages(v), [], `输入 ${JSON.stringify(v)} 应返回空数组`);
  }
  // 元素是垃圾也要跳过，不能抛
  assert.deepEqual(QQBridge.parseForwardMessages({ messages: [null, 1, "x"] }), []);
});

test("parseForwardMessages：图片/表情等非文本段不丢，转成标记", () => {
  const res = { messages: [{ sender: { nickname: "A" }, message: [{ type: "image", data: {} }, { type: "face", data: {} }] }] };
  const it = QQBridge.parseForwardMessages(res)[0];
  assert.equal(it.text, "[图片][表情]");
});

// ── renderForward：给模型看的文本块 ───────────────────────────────────

test("renderForward：输出带编号的可读格式", () => {
  const t = QQBridge.renderForward([
    { name: "小灰灰", text: "你好" },
    { name: "故梦", text: "[表情]" },
  ]);
  assert.match(t, /^〔转发消息 共 2 条〕/);
  assert.match(t, /〔第1条〕小灰灰: 你好/);
  assert.match(t, /〔第2条〕故梦: \[表情\]/);
});

test("renderForward：空内容给出说明，而不是空白", () => {
  assert.match(QQBridge.renderForward([]), /转发消息/);
  assert.match(QQBridge.renderForward(null), /转发消息/);
});

test("renderForward：超长内容按预算截断（防上下文被长转发撑爆）", () => {
  const items = Array.from({ length: 50 }, (_, i) => ({ name: `U${i}`, text: "字".repeat(200) }));
  const t = QQBridge.renderForward(items, 1000);
  assert.ok(t.length <= 1000 + 20, `应截断到约 1000 字符，实际 ${t.length}`);
  assert.match(t, /已截断/);
});

test("renderForward：名字缺失时不输出突兀的冒号", () => {
  const t = QQBridge.renderForward([{ name: "未知", text: "内容" }]);
  assert.match(t, /〔第1条〕内容/);
  assert.doesNotMatch(t, /未知:/);
});

// ── bridge 接线 ──────────────────────────────────────────────────────

test("bridge 在空文本闸之前展开转发（否则事件会被整条丢弃）", () => {
  const iForward = BRIDGE_SRC.indexOf("rawText = await expandForward(");
  const iGate = BRIDGE_SRC.indexOf("if (!rawText) return;");
  assert.ok(iForward > 0, "没找到 expandForward 调用点");
  assert.ok(iGate > 0, "没找到空文本闸");
  assert.ok(iForward < iGate, "展开必须在 `if (!rawText) return` 之前，否则转发事件会被静默丢弃");
});

test("bridge 的 expandForward 失败时给说明而非静默丢弃（防模型编造）", () => {
  const i = BRIDGE_SRC.indexOf("async function expandForward");
  assert.ok(i > 0);
  const seg = BRIDGE_SRC.slice(i, i + 1600);
  assert.match(seg, /catch/, "应捕获拉取失败");
  assert.match(seg, /拉取失败|无法识别/, "失败时应产出说明性文案，让模型知道内容存在但读不到");
});

test("qqbridge 暴露 getForwardMsg 且走 get_forward_msg", () => {
  const src = fs.readFileSync(path.join(ROOT, "lib/qqbridge.mjs"), "utf8");
  assert.match(src, /getForwardMsg\(forwardId\)\s*\{[\s\S]{0,160}get_forward_msg/);
});

// ── 群聊限制：直发的转发卡片不喂模型，仅引用时展开 ──────────────────────

test("群聊里别人直接发的合并转发不展开，只给说明性占位符", () => {
  // 【为什么】群里随手转发的聊天记录卡片并未指向 bot，内容可能来自别处（含他人对话），
  // 整段灌进模型既噪又牵涉隐私。只有用户主动引用（回复）那条转发，才算明确请求。
  const i = BRIDGE_SRC.indexOf("if (directForward)");
  assert.ok(i > 0, "没找到 directForward 分支");
  const seg = BRIDGE_SRC.slice(i, i + 700);
  assert.match(seg, /群聊默认不展开|请引用/, "应降级为说明性占位符");
  assert.doesNotMatch(seg.slice(0, seg.indexOf("} else {")), /expandForward/, "该分支不得调用 expandForward");
});

test("directForward 的判定是「群聊 + 顶层有 forward 段」", () => {
  const i = BRIDGE_SRC.indexOf("const directForward =");
  assert.ok(i > 0, "没找到 directForward 定义");
  const seg = BRIDGE_SRC.slice(i, i + 300);
  assert.match(seg, /message_type === "group"/, "必须限定群聊（私聊转发给 bot 是明确意图，应照常展开）");
  assert.match(seg, /type === "forward"/, "必须检测顶层 forward 段");
});

test("被引用的转发仍然会展开（只有引用才给模型）", () => {
  const i = BRIDGE_SRC.indexOf("if (rawText.includes(\"[转发\"))");
  assert.ok(i > 0, "没找到转发处理入口");
  const seg = BRIDGE_SRC.slice(i, i + 900);
  assert.match(seg, /else \{\s*\n\s*rawText = await expandForward/, "非 directForward 时（即被引用）必须展开");
});

test("不展开时不得静默丢弃（要留说明，避免模型以为消息为空）", () => {
  const i = BRIDGE_SRC.indexOf("if (directForward)");
  const seg = BRIDGE_SRC.slice(i, i + 700);
  assert.match(seg, /〔转发消息/, "必须产出可读占位符");
});
