/**
 * 模型定义与「配置里写的模型 ID」必须对得上。
 *
 * 背景（真实事故 2026-10-19）：
 * config.pi.model 是 "omniroute/deepseek-v4.1-flash"，但 OMNIROUTE_MODELS 里
 * 只注册了 "openai/deepseek-flash" 与 "deepseek-flash"。于是这个 ID 落到了
 * 网关的**动态目录**里 —— 那份定义没有 reasoning / thinkingLevelMap，
 * SDK 的 getSupportedThinkingLevels() 便返回 ["off"]（认为模型不支持思考），
 * 任何思考等级都被 clamp 成 off。外部表现：日志里出现
 * `思考等级 → off（请求 max）`，而推理模型的正文/推理分离问题
 * （token 全花在推理上、正文为空）也就无从缓解。
 *
 * 本测试锁死：静态注册表里的 deepseek 系模型必须带 reasoning 与 thinkingLevelMap，
 * 且 config.pi.model 用的那个 ID 必须在注册表里（否则会退回动态目录定义）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { OMNIROUTE_MODELS, DEEPSEEK_MODELS } from "../lib/model-config.mjs";

/** 本项目思考等级映射：off 由 SDK 隐式可用；minimal/medium 显式关闭；low/high/max 开放 */
const EXPECTED_THINKING_MAP = { minimal: null, low: "low", medium: null, high: "high", max: "max" };

/** SDK 的等级过滤规则（见 pi-coding-agent dist 的 getSupportedThinkingLevels）：
 *  mapped === null → 剔除；xhigh/max 还要求 mapped !== undefined；其余保留。 */
function supportedLevels(model) {
  const ALL = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
  if (!model.reasoning) return ["off"];
  return ALL.filter((lv) => {
    const mapped = model.thinkingLevelMap?.[lv];
    if (mapped === null) return false;
    if (lv === "xhigh" || lv === "max") return mapped !== undefined;
    return true;
  });
}

test("deepseek 系模型必须标记 reasoning，否则思考等级会被压成 off", () => {
  for (const m of [...OMNIROUTE_MODELS, ...DEEPSEEK_MODELS]) {
    if (!String(m.id).includes("deepseek")) continue;
    assert.equal(m.reasoning, true, `${m.id} 缺 reasoning:true —— 会被 SDK 判定为不支持思考`);
  }
});

test("deepseek 系模型的 thinkingLevelMap 必须与约定一致", () => {
  for (const m of [...OMNIROUTE_MODELS, ...DEEPSEEK_MODELS]) {
    if (!String(m.id).includes("deepseek")) continue;
    assert.deepEqual(m.thinkingLevelMap, EXPECTED_THINKING_MAP, `${m.id} 的 thinkingLevelMap 不符`);
  }
});

test("deepseek 系模型必须支持 max 思考等级", () => {
  for (const m of [...OMNIROUTE_MODELS, ...DEEPSEEK_MODELS]) {
    if (!String(m.id).includes("deepseek")) continue;
    const levels = supportedLevels(m);
    assert.ok(levels.includes("max"), `${m.id} 不支持 max（实际可用: ${levels.join("/")}）`);
    assert.ok(levels.includes("high"), `${m.id} 不支持 high`);
    assert.ok(!levels.includes("medium"), `${m.id} 不应暴露 medium（映射里是 null）`);
  }
});

test("config.pi.model 用到的模型 ID 必须在静态注册表里", async () => {
  const { config } = await import("../lib/config.mjs");
  const ref = String(config.pi?.model ?? "");
  if (!ref) return; // 未配置则跳过
  const [provider, id] = ref.includes("/") ? ref.split("/", 2) : ["", ref];
  if (provider !== "omniroute") return; // 只校验本项目实际使用的网关
  const ids = OMNIROUTE_MODELS.map((m) => m.id);
  assert.ok(
    ids.includes(id),
    `config.pi.model 用的是 "${ref}"，但 OMNIROUTE_MODELS 里没有 "${id}"（现有: ${ids.join(", ")}）。` +
      `不在注册表里会退回网关动态目录定义，丢失 reasoning/thinkingLevelMap。`,
  );
});

test("注册表里的模型 ID 不重复", () => {
  for (const list of [OMNIROUTE_MODELS, DEEPSEEK_MODELS]) {
    const ids = list.map((m) => m.id);
    assert.equal(new Set(ids).size, ids.length, `模型 ID 有重复: ${ids.join(", ")}`);
  }
});
