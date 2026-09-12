/**
 * 权限授予策略（/op、/deop、qq-cli op/deop 共用的唯一实现）
 *
 * 【为什么抽出来】
 * 这段校验原先有**两份实现**：lib/piagent.mjs 的 _opUser/_deopUser 与
 * scripts/qq-cli.mjs 的 guardOp。两份逻辑必须永远一致，否则就会出现
 * 「一条路拦得住、另一条路拦不住」的提权缺口 —— 而这正是曾经发生的事：
 * qq-cli 那侧受「配置里的一个临时跳过开关」影响，一旦它为 true
 * 就**整个跳过等级校验**，让任何 operator 都能把自己提成 admin。
 * （config.json 里它确实是 true，属于测试残留。现已彻底删除该开关。）
 *
 * 本模块是**纯函数**，不碰文件、不读配置，便于单测与复用。
 */

/** 预设等级（数字越大权限越高） */
export const PRESET_LEVEL = Object.freeze({ dialog: 0, friend: 1, operator: 2, admin: 3 });

/** 可被授予的预设（dialog 是「无权限」基线，不作为授予目标） */
export const GRANTABLE = Object.freeze(["friend", "operator", "admin"]);

/**
 * 各等级「最多能授予到哪一档」。
 *
 * 这是本次收紧的核心：**operator 只能拉人进 friend 档**。
 * 理由：若 operator 能授出 operator，就能靠「造小号」级联放大权限，
 * 最终自己爬到 admin；限死在 friend（只读记忆 + 信息查询）后，
 * 「带个新人进来」这种常见需求依然满足，但级联放大的链条被切断。
 *
 * admin 上限是 operator（**不含 admin**）—— 这保持了原有语义「不得授予同级或更高」。
 * 要新增一个 admin，需直接编辑 whitelist.json（admin 本来就有 files:full，能做到）。
 * 这样设计的好处是：提权永远需要一次「文件级」操作，而不是一条命令就能复制最高权限。
 */
export const MAX_GRANT = Object.freeze({ dialog: null, friend: null, operator: "friend", admin: "operator" });

/** 把用户条目（预设名或数组）折算成等级数字 */
export function levelOf(term) {
  if (Array.isArray(term)) {
    let lv = 0;
    for (const t of term) if (typeof t === "string" && PRESET_LEVEL[t] !== undefined) lv = Math.max(lv, PRESET_LEVEL[t]);
    return lv;
  }
  return PRESET_LEVEL[String(term)] ?? 0;
}

/** 等级 → 预设名（用于对外文案，不暴露数字） */
export function presetNameOf(term) {
  const lv = levelOf(term);
  return Object.keys(PRESET_LEVEL).find((k) => PRESET_LEVEL[k] === lv) ?? "dialog";
}

/**
 * 校验一次「授予」操作。
 *
 * @param {{callerPreset:any, targetPreset:any, preset:string}} p
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 *          text 里**不含**任何等级数字 —— 避免把对方权限等级泄露给调用者
 *          （否则任何活跃群成员都能靠试错探出谁有权限、权限多高）
 */
export function checkGrant({ callerPreset, targetPreset, preset }) {
  if (!preset) return { ok: false, code: "usage", text: "用法: /op <QQ号> <friend|operator|admin>" };
  if (!GRANTABLE.includes(preset) || PRESET_LEVEL[preset] === 0) {
    return { ok: false, code: "bad-preset", text: `预设「${preset}」不存在（可选：friend / operator / admin）` };
  }
  const callerLv = levelOf(callerPreset);
  const targetLv = levelOf(targetPreset);

  // 1) 不能修改「不低于自己」的目标（防止平级互改 / 以下犯上）
  if (targetLv >= callerLv) {
    return { ok: false, code: "target-too-high", text: "不能修改该用户：对方权限等级不低于你，已拒绝。" };
  }

  // 2) 不能超过自己这一档的授予上限
  //    （该上限恒小于自身等级，因此已隐含「不得授予同级或更高」，无需单独判一次）
  const cap = MAX_GRANT[presetNameOf(callerPreset)];
  if (!cap) {
    return { ok: false, code: "no-capability", text: "你的权限等级不具备授予权限的能力。" };
  }
  if (PRESET_LEVEL[preset] > PRESET_LEVEL[cap]) {
    return {
      ok: false,
      code: "above-cap",
      text: `不能授予 ${preset}：你最多只能授予 ${cap}。如需更高权限请联系管理员。`,
    };
  }
  return { ok: true };
}

/**
 * 校验一次「撤销」操作。
 * @param {{callerPreset:any, targetPreset:any, isTargetSelf?:boolean}} p
 * @returns {{ok:true}|{ok:false, code:string, text:string}}
 */
export function checkRevoke({ callerPreset, targetPreset, isTargetSelf = false }) {
  const callerLv = levelOf(callerPreset);
  const targetLv = levelOf(targetPreset);

  // 不允许撤销自己（避免误操作把自己踢成 dialog 后失去自救能力）
  if (isTargetSelf) {
    return { ok: false, code: "self-revoke", text: "不能撤销自己的权限（如需降级请让上级操作）。" };
  }
  if (targetLv >= callerLv) {
    return { ok: false, code: "target-too-high", text: "不能撤销该用户：对方权限等级不低于你，已拒绝。" };
  }
  // operator 只能撤销 friend 档
  const cap = MAX_GRANT[presetNameOf(callerPreset)];
  if (!cap) return { ok: false, code: "no-capability", text: "你的权限等级不具备管理权限的能力。" };
  if (targetLv > PRESET_LEVEL[cap]) {
    return { ok: false, code: "above-cap", text: `不能撤销该用户：其权限超出你被允许管理的范围。` };
  }
  return { ok: true };
}

export default { PRESET_LEVEL, GRANTABLE, MAX_GRANT, levelOf, presetNameOf, checkGrant, checkRevoke };
