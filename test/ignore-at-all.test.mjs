import test from "node:test";
import assert from "node:assert/strict";

import { QQBridge } from "../lib/qqbridge.mjs";

/**
 * 群聊 @全体成员 屏蔽 —— 单元测试
 *
 * 背景（别删这段注释，它解释了这些断言为什么长这样）：
 * QQ 的 @全体成员 在 OneBot11 里编码成 `{type:"at", data:{qq:"all"}}`，
 * 而旧版 isMentioned 把 qq==="all" 也当成「@ 了 bot」，于是**任何一条群公告**
 * 都会把潜水中的 bot 拽醒、白烧一遍 token 并可能对着公告自说自话。
 * 现在改为：@全体成员 且**没有单独 @ bot 本人**的消息整条忽略。
 *
 * 另外注意「两条来源」：at 段是主来源，但有人手打 `@all` / `@全体成员` 时
 * NapCat 不会生成 at 段，只走纯文本。只堵一条等于没堵 —— 所以两组用例都要有。
 */

const SELF = "2788144969";
const OTHER = "10001";

/** 构造一条 at 段 */
const at = (qq) => ({ type: "at", data: { qq: String(qq) } });
/** 构造一条文本段 */
const txt = (t) => ({ type: "text", data: { text: t } });

test("isAtAll：at 段 qq==='all' 才命中，@ 具体人（含 bot 自己）不算", () => {
  assert.equal(QQBridge.isAtAll([at("all")]), true);
  assert.equal(QQBridge.isAtAll([at(SELF)]), false);
  assert.equal(QQBridge.isAtAll([at(OTHER)]), false);
  assert.equal(QQBridge.isAtAll([txt("@全体成员")]), false, "纯文本不产生 at 段");
  assert.equal(QQBridge.isAtAll([]), false);
  assert.equal(QQBridge.isAtAll(undefined), false, "非数组要安全返回 false");
});

test("isAtSelf：只认 bot 本人，不把 'all' 算进来", () => {
  assert.equal(QQBridge.isAtSelf([at(SELF)], SELF), true);
  assert.equal(QQBridge.isAtSelf([at("all")], SELF), false, "这是关键 —— all 不等于 self");
  assert.equal(QQBridge.isAtSelf([at(OTHER)], SELF), false);
  assert.equal(QQBridge.isAtSelf([at(SELF)], 123456), false, "换一个 selfId 就不该命中");
});

test("isAtAllText：支持 @all / @全体成员 / @所有人，大小写不敏感，允许前导空白", () => {
  assert.equal(QQBridge.isAtAllText("@全体成员 今晚八点开会"), true);
  assert.equal(QQBridge.isAtAllText("@all 今晚八点开会"), true);
  assert.equal(QQBridge.isAtAllText("@ALL 今晚八点开会"), true);
  assert.equal(QQBridge.isAtAllText("@所有人 今晚八点开会"), true);
  assert.equal(QQBridge.isAtAllText("  @全体成员 前面有空格"), true);
  assert.equal(QQBridge.isAtAllText(""), false);
  assert.equal(QQBridge.isAtAllText(undefined), false);
});

test("isAtAllText：正文中间提到 @全体成员 不算公告（防误伤）", () => {
  // 只认行首 —— 否则讨论「怎么发群公告」的闲聊会被误吞
  assert.equal(QQBridge.isAtAllText("我刚刚手滑@全体成员了，不好意思"), false);
  assert.equal(QQBridge.isAtAllText("PI2X 你为什么会响应@全体成员"), false);
  assert.equal(QQBridge.isAtAllText("@全体成员们好"), false, "后面紧贴汉字，是另一个词");
});

test("shouldIgnoreAtAll：at 段的 @全体成员 → 忽略", () => {
  const msg = [at("all"), txt(" 今晚八点开会")];
  assert.equal(QQBridge.shouldIgnoreAtAll(msg, SELF, "@全体成员 今晚八点开会"), true);
});

test("shouldIgnoreAtAll：文本形式的 @全体成员 / @all / @所有人 → 同样忽略", () => {
  assert.equal(QQBridge.shouldIgnoreAtAll([txt("@全体成员 交作业")], SELF, "@全体成员 交作业"), true);
  assert.equal(QQBridge.shouldIgnoreAtAll([txt("@all 交作业")], SELF, "@all 交作业"), true);
  assert.equal(QQBridge.shouldIgnoreAtAll([txt("@所有人 交作业")], SELF, "@所有人 交作业"), true);
});

test("shouldIgnoreAtAll：后门 —— @全体成员 之外还单独 @ 了 bot 本人 → 放行", () => {
  const msg = [at("all"), at(SELF), txt(" PI2X 你看看这个")];
  assert.equal(
    QQBridge.shouldIgnoreAtAll(msg, SELF, "@全体成员 @PI2X 你看看这个"),
    false,
    "明确点名 @bot 的不能被公告一起吞掉",
  );
});

test("shouldIgnoreAtAll：普通消息 / @ 别人 / 只 @ bot → 都不忽略", () => {
  assert.equal(QQBridge.shouldIgnoreAtAll([txt("今天天气不错")], SELF, "今天天气不错"), false);
  assert.equal(QQBridge.shouldIgnoreAtAll([at(OTHER), txt(" 在吗")], SELF, "@张三 在吗"), false);
  assert.equal(QQBridge.shouldIgnoreAtAll([at(SELF), txt(" 帮我查个东西")], SELF, "@PI2X 帮我查个东西"), false);
  assert.equal(QQBridge.shouldIgnoreAtAll([], SELF, ""), false);
});

test("回归保护：isMentioned 的旧语义不要被动过", () => {
  // isMentioned 保留「all 也算命中」的历史行为（别的地方可能依赖）；
  // 屏蔽是在 bridge 层用 shouldIgnoreAtAll 另做的一道闸，不是靠改它。
  // 这条断言是防止后人顺手「修」掉它导致屏蔽逻辑失去意义。
  assert.equal(QQBridge.isMentioned([at("all")], SELF), true);
  assert.equal(QQBridge.isMentioned([at(SELF)], SELF), true);
  assert.equal(QQBridge.isMentioned([at(OTHER)], SELF), false);
});
