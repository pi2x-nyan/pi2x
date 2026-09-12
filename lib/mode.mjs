/**
 * 运行模式状态机 —— 三层降级链的状态与判定
 *
 * ┌──────────┬──────────────────────────────────────────────────────────┐
 * │ 模式      │ 含义                                                      │
 * ├──────────┼──────────────────────────────────────────────────────────┤
 * │ normal   │ 正常模式：完整功能（记忆、工具注册表、浏览器、subagent…）      │
 * │ safe     │ 安全模式：独立入口，最小依赖闭包 + 极简 agent（只 4 个基础工具） │
 * │ rollback │ 回退模式：纯脚本，无 agent，只会「回滚到已验证版本并拉起」      │
 * └──────────┴──────────────────────────────────────────────────────────┘
 *
 * 降级链是**单向**的：normal → safe → rollback。
 * 回退只能由人工发起（或 rollback 成功后人工切回），watchdog 不会自动回升 ——
 * 自动回升会在「修不好」和「又坏了」之间来回震荡，比停在低模式更糟。
 *
 * 【降级的触发条件（刻意收得很紧）】
 *   仅当「进程不存在」或「心跳停止」时自动降级。
 *   「进程活着但行为异常」（报错多、回复慢）**只告警不降级** ——
 *   看门狗一旦误判，就会把一个健康的完整版杀掉、换成残废的安全模式，
 *   那它就自己变成了新的故障源。宁可多报几次假警。
 *
 * 本模块的判定逻辑（decide）是纯函数，可独立单测；文件读写单独一组函数。
 */
import fs from "node:fs";
import path from "node:path";

export const MODES = Object.freeze(["normal", "safe", "rollback"]);

/** 默认阈值（可被 config.lifecycle 覆盖） */
export const DEFAULTS = Object.freeze({
  /** 正常/安全模式心跳间隔：每分钟一次 */
  heartbeatIntervalMs: 60_000,
  /** 多旧算「心跳停了」——给 3 分钟宽容，避免偶发卡顿误判 */
  heartbeatStaleMs: 180_000,
  /** 正常模式自动拉起次数上限：**先自救三次**，三次都失败才降级到安全模式 */
  maxNormalAttempts: 3,
  /** 安全模式连续拉不起来几次后，下沉到回退模式 */
  maxSafeAttempts: 3,
});

const MODE_FILE = "mode.json";
const HEARTBEAT_FILE = "heartbeat";

function nowIso(now = Date.now()) {
  return new Date(now).toISOString();
}

/** 校验模式名，非法值一律回落到 normal（宁可跑完整的，也不要卡在残缺模式） */
export function normalizeMode(m) {
  const v = String(m ?? "").trim().toLowerCase();
  return MODES.includes(v) ? v : "normal";
}

/**
 * 读取当前模式状态。文件缺失/损坏 → normal（安全的默认值）
 * @param {string} stateDir
 */
export function readMode(stateDir) {
  const file = path.join(stateDir, MODE_FILE);
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    return {
      mode: normalizeMode(raw.mode),
      since: raw.since ?? null,
      reason: raw.reason ?? null,
      normalAttempts: Number(raw.normalAttempts ?? 0),
      safeAttempts: Number(raw.safeAttempts ?? 0),
      updatedBy: raw.updatedBy ?? null,
      corrupt: false,
    };
  } catch (e) {
    return {
      mode: "normal",
      since: null,
      reason: null,
      normalAttempts: 0,
      safeAttempts: 0,
      updatedBy: null,
      corrupt: e?.code !== "ENOENT",
    };
  }
}

/**
 * 写入模式状态（原子写：临时文件 → rename，避免进程被杀时留半截 JSON）
 * @param {string} stateDir
 * @param {{mode?:string, reason?:string|null, normalAttempts?:number, safeAttempts?:number,
 *          resetAttempts?:boolean|'normal'|'safe', updatedBy?:string, now?:number}} patch
 */
export function writeMode(stateDir, patch = {}) {
  const cur = readMode(stateDir);
  let normalAttempts = patch.normalAttempts !== undefined ? patch.normalAttempts : cur.normalAttempts;
  let safeAttempts = patch.safeAttempts !== undefined ? patch.safeAttempts : cur.safeAttempts;
  if (patch.resetAttempts === true) {
    normalAttempts = 0;
    safeAttempts = 0;
  } else if (patch.resetAttempts === "normal") {
    normalAttempts = 0;
  } else if (patch.resetAttempts === "safe") {
    safeAttempts = 0;
  }
  const next = {
    mode: patch.mode ? normalizeMode(patch.mode) : cur.mode,
    since: patch.mode && normalizeMode(patch.mode) !== cur.mode ? nowIso(patch.now) : cur.since ?? nowIso(patch.now),
    reason: patch.reason !== undefined ? patch.reason : cur.reason,
    normalAttempts,
    safeAttempts,
    updatedBy: patch.updatedBy ?? cur.updatedBy,
  };
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, MODE_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, file);
  return next;
}

/** 重置尝试计数（正常模式被人工/看门狗确认健康后调用） */
export function resetAttempts(stateDir, which = true) {
  return writeMode(stateDir, { resetAttempts: which });
}

/**
 * 心跳：正常/安全模式定期调用，证明「我还活着」。
 *
 * 内容格式：`<pid> <timestamp>`。带上 pid 是为了能识别**上一个进程的残留心跳**——
 * 这个坑真踩过：手工测试留下一个心跳文件，之后进程重启（旧代码不写心跳），
 * 看门狗读到那个陈旧文件，把「刚启动的健康进程」误判成「卡死 212 分钟」并准备重启它。
 * 残留心跳比没有心跳更危险：没有心跳有宽限期，残留心跳会被当真。
 */
export function touchHeartbeat(stateDir, now = Date.now()) {
  fs.mkdirSync(stateDir, { recursive: true });
  const file = path.join(stateDir, HEARTBEAT_FILE);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${process.pid} ${now}\n`, "utf8");
  fs.renameSync(tmp, file);
  return now;
}

/** 原始解析心跳文件 → {pid, ts} 或 null（兼容旧的「纯数字时间戳」格式） */
export function readHeartbeat(stateDir) {
  try {
    const raw = fs.readFileSync(path.join(stateDir, HEARTBEAT_FILE), "utf8").trim();
    const m = /^(\d+)\s+(\d+)$/.exec(raw);
    if (m) return { pid: Number(m[1]), ts: Number(m[2]) };
    const ts = Number(raw); // 旧格式：只有时间戳
    if (Number.isFinite(ts)) return { pid: null, ts };
    return null;
  } catch {
    return null;
  }
}

/**
 * 心跳距今多久（毫秒）。文件不存在或不可解析返回 Infinity（= 从没活过）。
 *
 * @param {string} stateDir
 * @param {number} [now]
 * @param {{alivePids?:number[]}} [opts]
 *        传入 alivePids 时做「心跳归属校验」：若心跳记录的 pid 不在存活列表中，
 *        说明它是**上一个进程的残留**，一律视为 Infinity —— 否则刚启动的进程
 *        ／会因为一个陈旧文件被判成卡死。
 * @returns {number}
 */
export function heartbeatAge(stateDir, now = Date.now(), { alivePids } = {}) {
  const hb = readHeartbeat(stateDir);
  if (!hb || !Number.isFinite(hb.ts)) return Infinity;
  if (alivePids && hb.pid !== null && !alivePids.includes(hb.pid)) return Infinity;
  return Math.max(0, now - hb.ts);
}

/**
 * 降级决策（纯函数，无 IO）—— 看门狗的心脏
 *
 * 降级链：normal → safe → rollback
 *   1. normal 死了/心跳停了 → **先自动拉起 normal**，最多 maxNormalAttempts 次
 *   2. 三次都失败 → 降级到 safe
 *   3. safe 也拉不起来 maxSafeAttempts 次 → 降级到 rollback（纯回滚）
 *
 * @param {object} p
 * @param {string} p.mode           当前模式
 * @param {boolean} p.normalAlive   normal 模式进程是否存活
 * @param {boolean} p.safeAlive     safe 模式进程是否存活
 * @param {number} p.heartbeatAgeMs 心跳年龄（毫秒），Infinity = 从未有心跳
 * @param {number} [p.normalAttempts] normal 模式已尝试自动拉起次数
 * @param {number} [p.safeAttempts]   safe 模式已尝试拉起次数
 * @param {boolean} [p.abnormal]      进程活着但被判定行为异常（仅告警，永不降级）
 * @param {number} [p.heartbeatStaleMs]
 * @param {number} [p.maxNormalAttempts]
 * @param {number} [p.maxSafeAttempts]
 * @returns {{action:"none"|"alert"|"restart-normal"|"degrade-safe"|"start-safe"|"degrade-rollback", reason:string}}
 */
export function decide({
  mode,
  normalAlive = false,
  safeAlive = false,
  heartbeatAgeMs = Infinity,
  normalAttempts = 0,
  safeAttempts = 0,
  abnormal = false,
  heartbeatStaleMs = DEFAULTS.heartbeatStaleMs,
  maxNormalAttempts = DEFAULTS.maxNormalAttempts,
  maxSafeAttempts = DEFAULTS.maxSafeAttempts,
} = {}) {
  const m = normalizeMode(mode);

  // 行为异常只告警，永不降级（见文件头说明）
  if (abnormal && m === "normal" && normalAlive) {
    return { action: "alert", reason: "正常模式进程存活但行为异常（仅告警，不降级）" };
  }

  if (m === "normal") {
    if (!normalAlive) {
      // 进程没了 —— 这是最确定的信号，无需依赖心跳
      if (normalAttempts < maxNormalAttempts) {
        return { action: "restart-normal", reason: `正常模式进程不存在，第 ${normalAttempts + 1}/${maxNormalAttempts} 次自动拉起` };
      }
      return { action: "degrade-safe", reason: `正常模式进程不存在，且自动拉起已失败 ${normalAttempts} 次 → 降级到安全模式` };
    }

    // 进程活着。
    // ・心跳文件从未产生（Infinity）→ 处于「宕机探测能力尚未部署」的宽限期，
    //   仅凭进程存活判定健康（否则一部署看门狗就会把健康的进程反复重启）。
    //   一旦心跳存在过，就按新鲜度严格判定。
    // ・心跳过期 → 进程卡死，需要唤醒。
    if (Number.isFinite(heartbeatAgeMs) && heartbeatAgeMs > heartbeatStaleMs) {
      const mins = Math.round(heartbeatAgeMs / 60000);
      const why = `正常模式心跳已停 ${mins} 分钟`;
      if (normalAttempts < maxNormalAttempts) {
        return { action: "restart-normal", reason: `${why}，第 ${normalAttempts + 1}/${maxNormalAttempts} 次自动拉起` };
      }
      return { action: "degrade-safe", reason: `${why}，且自动拉起已失败 ${normalAttempts} 次 → 降级到安全模式` };
    }

    return { action: "none", reason: "正常模式健康" };
  }

  if (m === "safe") {
    if (safeAlive) return { action: "none", reason: "安全模式运行中" };
    if (safeAttempts < maxSafeAttempts) {
      return { action: "start-safe", reason: `安全模式进程不存在，第 ${safeAttempts + 1}/${maxSafeAttempts} 次尝试拉起` };
    }
    return { action: "degrade-rollback", reason: `安全模式连续 ${safeAttempts} 次拉不起来，下沉到回退模式` };
  }

  // rollback：不再自动做任何事，等人工处理
  return { action: "none", reason: "已处于回退模式，等待人工修复" };
}

export default {
  MODES,
  DEFAULTS,
  normalizeMode,
  readMode,
  writeMode,
  touchHeartbeat,
  readHeartbeat,
  heartbeatAge,
  decide,
  resetAttempts,
};
