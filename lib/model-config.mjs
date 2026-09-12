/**
 * 模型与 provider 装配 —— 正常模式与安全模式共用
 *
 * 【为什么单独抽出来】
 * provider 注册这四十来行原本只写在 lib/piagent.mjs 里。安全模式（bridge-safe.mjs）
 * 需要同一套模型配置，但如果直接复制一份，就埋下了「改一处忘一处」的漂移隐患
 * —— 而这正是本次重构一直在消灭的问题（见 REFACTOR-2026-09.md）。
 * 抽成独立模块后，两个入口 import 同一份实现，且本模块依赖极轻：
 * 只有 pi SDK 与 lib/config.mjs。
 */
import { ModelRuntime, resolveCliModel } from "@earendil-works/pi-coding-agent";
import { config } from "./config.mjs";

/** OmniRoute（ARM 网关，OpenAI 兼容）暴露的模型 */
export const OMNIROUTE_MODELS = Object.freeze([
  {
    id: "free",
    name: "免费池组合（mimo→openrouter→nemotron 自动路由）",
    input: ["text", "image"],
    contextWindow: 1000000,
    maxTokens: 65536,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  },
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
  },
]);

/** DeepSeek 直连暴露的模型（官方目录已收敛为 v4.1） */
export const DEEPSEEK_MODELS = Object.freeze([
  {
    id: "deepseek-flash",
    name: "DeepSeek V4.1 Flash",
    reasoning: true,
    input: ["text"],
    contextWindow: 1000000,
    maxTokens: 384000,
    cost: { input: 0.14, output: 0.28, cacheRead: 0.0028, cacheWrite: 0 },
    compat: {
      supportsStore: false,
      supportsDeveloperRole: false,
      maxTokensField: "max_tokens",
      requiresReasoningContentOnAssistantMessages: true,
      thinkingFormat: "deepseek",
    },
    thinkingLevelMap: { minimal: null, low: "low", medium: null, high: "high", max: "max" },
  },
]);

/**
 * 创建 ModelRuntime 并注册自定义 provider。
 * @param {{logger?: {info:Function, warn:Function}}} [opts]
 * @returns {Promise<ModelRuntime>}
 */
export async function createModelRuntime({ logger = console } = {}) {
  const rt = await ModelRuntime.create();

  // OmniRoute 网关（可选的自建网关）。地址与密钥**只从环境变量读取，不给默认值** ——
  // 原先代码里写死了内网地址与 API key 作兜底，那既是拓扑泄露也是一个真实可用的密钥。
  // 未配置时跳过注册（不影响其他 provider）。
  // 优先级：环境变量 > 本地 config.json（两者都不会进公开仓库）
  const omniBase = process.env.OMNIROUTE_BASE_URL || config.omniroute?.baseUrl;
  const omniKey = process.env.OMNIROUTE_API_KEY || config.omniroute?.apiKey;
  if (omniBase && omniKey) {
    try {
      rt.registerProvider("omniroute", {
        name: "OmniRoute (自建网关)",
        baseUrl: omniBase,
        apiKey: omniKey,
        api: "openai-completions",
        models: OMNIROUTE_MODELS,
      });
    } catch (e) {
      logger.warn?.(`omniroute provider 注册失败: ${e?.message}`);
    }
  } else {
    logger.debug?.("未配置 OMNIROUTE_BASE_URL / OMNIROUTE_API_KEY，跳过 omniroute provider");
  }

  try {
    rt.registerProvider("deepseek", {
      name: "DeepSeek（直连）",
      baseUrl: "https://api.deepseek.com",
      api: "openai-completions",
      apiKey: process.env.DEEPSEEK_API_KEY,
      models: DEEPSEEK_MODELS,
      overwrite: true,
    });
  } catch (e) {
    logger.warn?.(`deepseek provider 覆盖失败: ${e?.message}`);
  }

  return rt;
}

/**
 * 解析要用的模型。必须在 createModelRuntime 之后调用，
 * 否则自定义 provider 尚未注册，解析不到。
 *
 * @param {ModelRuntime} modelRuntime
 * @param {{cliModelId?:string, logger?:{info:Function,warn:Function}}} [opts]
 * @returns {any|undefined} 模型对象；解析失败返回 undefined（交给 SDK 自选）
 */
export function resolveModel(modelRuntime, { cliModelId, logger = console } = {}) {
  const id = cliModelId ?? process.env.PI2X_MODEL ?? config.pi?.model;
  if (!id) return undefined;
  const r = resolveCliModel({ cliModel: id, modelRuntime });
  if (r.error) {
    logger.warn?.(`模型解析失败(${id}): ${r.error}，将自动选择`);
    return undefined;
  }
  return r.model;
}

export default { createModelRuntime, resolveModel, OMNIROUTE_MODELS, DEEPSEEK_MODELS };
