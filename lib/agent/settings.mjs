/**
 * pi 会话设置 —— 单一来源
 *
 * 为什么必须显式传入，而不是直接用 `SettingsManager.inMemory()` 的默认值：
 *
 * pi 生成压缩摘要时的输出上限是：
 *     maxTokens = min(floor(0.8 × reserveTokens), model.maxTokens)
 * pi 默认 reserveTokens = 16384 ⇒ 摘要最多只能写 13107 token。
 *
 * 被压缩的历史一旦很长（实测：1544 条消息 / 约 55 万 token），摘要会写满上限被
 * 硬截断，pi 随即判定「摘要不完整」并**直接放弃整次压缩**（见 pi 源码
 * `getSummarizationFailure()`：stopReason === "length" 即判失败）。
 *
 * 这个故障非常隐蔽，有三个原因：
 *   1) 报错文案是「Nothing to compact (session too small)」之类的误导性措辞，
 *      或者「generation hit the token cap」——都不像是「预算不够」；
 *   2) 是否踩到上限带随机性：同样规模的输入，一次成功、一次失败（取决于模型
 *      那一次啰嗦不啰嗦），所以极难复现；
 *   3) 失败是静默放弃：上下文一条不少，从外部看就是「压缩没反应」。
 *
 * 把 reserveTokens 提到 64K 后，摘要预算 = 0.8 × 65536 = 52428 token，余量充足。
 * 附带影响：pi 自身的自动压缩阈值变为 contextWindow - reserveTokens（1M 窗口下
 * 约 93%），但 PI2X 有自己的 compactPercent（默认 40%）触发，不受影响。
 */
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { config } from "../config.mjs";

/** 摘要输出预算（reserveTokens）：0.8× 即为摘要上限 */
export const SUMMARIZATION_RESERVE_TOKENS = 65536;

/** 压缩后保留的近期上下文 token 数（这些不参与摘要，原样保留） */
export const KEEP_RECENT_TOKENS = 40000;

/**
 * 构造 PI2X 统一使用的 pi 设置。
 * 允许调用方覆盖，但压缩相关字段默认由本模块给出（避免各处再散落默认值）。
 *
 * @param {Record<string, unknown>} [overrides]
 */
export function makeSettingsManager(overrides = {}) {
  const p = config.pi ?? {};
  const { compaction: compactionOverride, ...rest } = overrides;
  return SettingsManager.inMemory({
    ...rest,
    compaction: {
      enabled: true,
      reserveTokens: positive(
        compactionOverride?.reserveTokens ?? p.compactionReserveTokens,
        SUMMARIZATION_RESERVE_TOKENS,
      ),
      keepRecentTokens: positive(
        compactionOverride?.keepRecentTokens ?? p.compactionKeepRecentTokens,
        KEEP_RECENT_TOKENS,
      ),
    },
  });
}

/**
 * 只接受有限正数，否则回落到默认值。
 * 不能省这一步：NaN 会一路传下去（0.8 × NaN = NaN），摘要预算变成 NaN 后
 * pi 的行为无从预料，属于「配错了反而更难查」的那类坑。
 */
function positive(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
