import fs from "node:fs";
import { memorySourceOf } from "./memory-source.mjs";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { loadPrompt } from "./prompts.mjs";
import { createLogger } from "./log.mjs";

const logMem = createLogger("memory");

/**
 * MemoryStore —— PI2X 无感记忆层 v2
 *
 * 存储: node:sqlite (memory.db) + 向量检索 (统一 384 维，默认 multilingual-e5-small，本地)
 * 能力: 自动收割(写) / 混合检索注入(读) / 显式查询 / 遗忘淘汰 / 后台反思
 *
 * v2 相对 v1 的关键修正（参考 Mem0 / Zep-Graphiti / Letta-MemGPT / Generative Agents / MemoryBank）：
 *  1. 几何校准：稠密向量空间各向异性（无关对余弦中位 ≈0.87）会让绝对相似度失去意义。
 *     做法 = 去均值(ABTT，减全库均值方向后重新归一化) + CSLS 局部密度惩罚（抑制枢纽点）。
 *     打分再按 Generative Agents 的方式做候选集内 min-max 归一化后加权。
 *  2. 重要性：收割时由 LLM 顺带给 1-10 分（不额外增加调用），参与打分与淘汰。
 *  3. 真实使用信号：收割时由 LLM 回传「上一轮注入的哪几条真被用到了」，据此刷 lastUsed/useCount。
 *  4. 双时间轴（Graphiti）：facts.valid_from / valid_until / superseded_by，新断言覆盖旧断言时
 *     旧条目失效而非删除，检索默认只看当前有效；旧版本进 fact_history 可查。
 *  5. 淘汰：艾宾浩斯遗忘曲线 R = e^(-Δt/S)，S = 1 + 使用次数 + 重要性/2（MemoryBank），
 *     而非纯 LRU。
 *  6. 反思（Generative Agents reflection / Letta sleep-time）：把零散事实合成更高层洞见，
 *     存为 type='reflection' 的常驻条目。
 */
export class MemoryStore {
  /**
   * @param {object} opts
   * @param {string} opts.dbPath        SQLite 文件路径
   * @param {string} [opts.modelDir]    embedding 模型缓存目录
   * @param {number} [opts.harvestIntervalMs] 同会话收割节流 (默认 10min)
   * @param {number} [opts.maxFacts]    事实上限 (默认 500)
   * @param {number} [opts.injectChars] 单次注入预算 (默认 2500)
   * @param {string} [opts.harvestModel] 收割用模型 (默认 deepseek-chat)
   */
  constructor(opts = {}) {
    this.dbPath = opts.dbPath;
    this.modelDir = opts.modelDir ?? path.join(path.dirname(opts.dbPath), "models");
    this.harvestIntervalMs = opts.harvestIntervalMs ?? 10 * 60 * 1000;
    this.maxFacts = opts.maxFacts ?? 500;
    this.injectChars = opts.injectChars ?? 2500;
    this.harvestModel = opts.harvestModel ?? "deepseek-chat";
    this.db = null;
    this._embedder = null;
    this._embedPromise = null;
    this._harvesting = new Set(); // 会话收割互斥
    this._EMB_DIM = 384; // 统一 384 维（库内既有向量与代码一致；换模型必须重嵌）
    // 模型与前缀可由 config.memory 覆盖：embedModel / embedPrefixQuery / embedPrefixPassage
    this.embedModel = opts.embedModel ?? "Xenova/multilingual-e5-small";
    this.embedPrefixQuery = opts.embedPrefixQuery ?? "";
    this.embedPrefixPassage = opts.embedPrefixPassage ?? "";

    // ── 几何校准（v2 核心）
    this.center = opts.center !== false;               // 去均值(ABTT)
    this.useCsls = opts.useCsls === true;              // CSLS 局部密度惩罚（实验：小库上偏保守，默认关）
    this.cslsK = opts.cslsK ?? 10;
    // 相似度阈值都在「居中空间」表达（由 calibrate() 实测分布选定，见 README/注释）：
    this.mergeSim = opts.mergeSim ?? 0.56;             // ≥ 视为同一断言（再按数值/包含关系决定富化还是覆盖）
    this.relatedSim = opts.relatedSim ?? 0.40;         // 相关但不合并的下界（仅用于 CLI 提示）
    this.gateSim = opts.gateSim ?? 0.20;               // 居中余弦绝对门槛（低于此视为不相关，不召回）
    this.gateRel = opts.gateRel ?? 0.4;                // 相对门槛：候选多时，低于 0.4×最高分 的丢弃
    // 打分权重（Generative Agents：各维度归一化后加权）
    this.weights = Object.assign(
      { relevance: 3.0, importance: 2.0, recency: 0.5, keyword: 1.5, pinned: 0.5 },
      opts.weights ?? {}
    );
    this.recencyDecay = opts.recencyDecay ?? 0.995;    // 每小时衰减（GAM 同值）
    // 淘汰模式：forgetting（艾宾浩斯，默认）| lru
    this.evictMode = opts.evictMode ?? "forgetting";
    // 覆盖旧断言：仅当高相似且数值不同（IP/端口/版本/模型名这类「同一槽位换值」）
    this.autoSupersede = opts.autoSupersede !== false;

    this._geomDirty = true;
    this._mu = null;
    this._hubCache = null;
  }

  init() {
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS facts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        tags TEXT NOT NULL DEFAULT '[]',
        source TEXT NOT NULL,
        ts INTEGER NOT NULL,
        lastUsed INTEGER NOT NULL DEFAULT 0,
        useCount INTEGER NOT NULL DEFAULT 0,
        pinned INTEGER NOT NULL DEFAULT 0,
        sensitive INTEGER NOT NULL DEFAULT 0,
        embedding BLOB NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_facts_type  ON facts(type);
      CREATE INDEX IF NOT EXISTS idx_facts_pin   ON facts(pinned);
      CREATE INDEX IF NOT EXISTS idx_facts_lastu ON facts(lastUsed);
      CREATE INDEX IF NOT EXISTS idx_facts_ts    ON facts(ts);

      CREATE TABLE IF NOT EXISTS global_facts (
        id TEXT PRIMARY KEY,
        content TEXT NOT NULL,
        enabled INTEGER NOT NULL DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS harvest_log (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session TEXT NOT NULL,
        user_id TEXT NOT NULL,
        ts INTEGER NOT NULL,
        round INTEGER NOT NULL DEFAULT 0,
        count INTEGER NOT NULL DEFAULT 0,
        detail TEXT
      );

      CREATE TABLE IF NOT EXISTS user_perms (
        user_id     TEXT PRIMARY KEY,
        preset      TEXT NOT NULL,
        updated_at  INTEGER NOT NULL,
        updated_by  TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS evicted_facts (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        content TEXT NOT NULL,
        source TEXT NOT NULL,
        ts INTEGER NOT NULL,
        evicted_at INTEGER NOT NULL,
        use_count INTEGER NOT NULL DEFAULT 0
      );

      -- v2: 断言历史（被新事实覆盖的旧版本，可审计）
      CREATE TABLE IF NOT EXISTS fact_history (
        fact_id     TEXT NOT NULL,
        content     TEXT NOT NULL,
        ts          INTEGER NOT NULL,
        replaced_at INTEGER NOT NULL,
        reason      TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_hist_fact ON fact_history(fact_id);

      -- v2: 几何统计缓存（均值方向/阈值实测值，避免每次启动重算）
      CREATE TABLE IF NOT EXISTS geometry_cache (
        key   TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);
    this._migrate();
    this._seedGlobals();
    this._geomDirty = true;
    return this;
  }

  /** 兼容旧库：补齐 v2 新列（幂等） */
  _migrate() {
    const cols = new Set(this.db.prepare("PRAGMA table_info(facts)").all().map((r) => r.name));
    const add = (name, ddl) => { if (!cols.has(name)) this.db.exec(`ALTER TABLE facts ADD COLUMN ${ddl}`); };
    add("importance", "importance INTEGER NOT NULL DEFAULT 5"); // LLM 打的 1-10 重要性
    add("valid_from", "valid_from INTEGER");        // 事实成立时间（默认取 ts）
    add("valid_until", "valid_until INTEGER");      // NULL = 仍然有效（Graphiti t_invalid）
    add("superseded_by", "superseded_by TEXT");     // 覆盖它的新条目 id
    this.db.exec("CREATE INDEX IF NOT EXISTS idx_facts_valid ON facts(valid_until)");
    // 回填 valid_from
    this.db.prepare("UPDATE facts SET valid_from = ts WHERE valid_from IS NULL").run();
  }

  _markGeomDirty() { this._geomDirty = true; this._hubCache = null; }

  /** 强制重算均值方向（写入后调用） */
  invalidateGeometry() { this._markGeomDirty(); }
  // ─────────────────────── 用户权限预设（配合白名单审计） ───────────────────────
  /** 记录/更新某用户的权限预设（仅 op/deop 工具调用，自动写入） */
  setUserPerm(userId, preset, updatedBy) {
    this.db
      .prepare("INSERT OR REPLACE INTO user_perms (user_id, preset, updated_at, updated_by) VALUES (?, ?, ?, ?)")
      .run(String(userId), String(preset), Date.now(), String(updatedBy));
  }

  /** 查询用户权限预设（CLI 用） */
  userPerms() {
    return this.db.prepare("SELECT * FROM user_perms ORDER BY updated_at DESC").all();
  }

  // ─────────────────────────── 全局种子 ───────────────────────────
  /**
   * 写入「全局常驻记忆」的种子事实。
   *
   * 【设计原则：通用规则硬编码，部署信息从配置推导】
   * 原先这里把本机部署细节写死在代码里（内网 IP、主机名、管理员 QQ、
   * 组网地址），这些内容一旦进公开仓库就是隐私与拓扑泄露。
   * 现在只硬编码「与部署无关的通用规则」，其余从 config / whitelist 推导 ——
   * 换了机器、换了账号，种子会自动跟着变，不需要改代码。
   */
  _seedGlobals() {
    const seeds = ["回复默认不使用 Markdown（不要使用 **加粗**、*斜体*、代码块、表格、列表符号等任何 Markdown 标记，除非用户明确要求格式化，一律纯文本）"];

    // 1) bot 自身账号（来自配置）
    let botQQ = null;
    try {
      const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      botQQ = String(JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"))?.napcat?.qqAccount ?? "") || null;
    } catch {
      /* 读不到就跳过这条种子 */
    }
    if (botQQ) seeds.push(`QQ 账号 ${botQQ}（bot 自身）`);

    // 2) 管理员列表（来自白名单，而非写死某个 QQ）
    try {
      const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const wl = JSON.parse(fs.readFileSync(path.join(ROOT, "whitelist.json"), "utf8"));
      const admins = Object.entries(wl.users ?? {})
        .filter(([, v]) => v === "admin" || (Array.isArray(v) && v.includes("admin")))
        .map(([k]) => k);
      for (const a of admins) seeds.push(`管理员 QQ ${a}`);
    } catch {
      /* 读不到就跳过 */
    }

    // 3) 跨机执行通道（来自配置，绝不写死地址）
    try {
      const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
      const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
      const ws = cfg.winShell;
      if (ws?.enabled && ws.host) {
        const alt = ws.fallbackHost ? `，不通自动回退 ${ws.fallbackHost}:${ws.port}` : "";
        seeds.push(`跨机执行通道优先走 ${ws.host}:${ws.port}${alt}；可远程执行命令与传输文件`);
      }
    } catch {
      /* 读不到就跳过 */
    }

    this.db.prepare("INSERT OR IGNORE INTO global_facts (id, content, enabled) VALUES (?, ?, 1)");
    // 清理历史遗留的错误种子（旧版写死过前任 bot 账号与若干部署细节）
    this.db.prepare("DELETE FROM global_facts WHERE content LIKE 'QQ 账号 未知%'").run();
    this.db.prepare("DELETE FROM global_facts WHERE content LIKE 'PI2X 运行于%'").run();
    this.db.prepare("DELETE FROM global_facts WHERE content LIKE 'Windows 主机%'").run();
    this.db.prepare("DELETE FROM global_facts WHERE content LIKE 'EasyTier 组网%'").run();
    const ins = this.db.prepare("INSERT OR IGNORE INTO global_facts (id, content, enabled) VALUES (?, ?, 1)");
    // 同一主题只留一条。
    //
    // 【为什么不能直接无条件插种子】种子是「每次启动都重新插入」的，而用户/收割
    // 可能已经写过一条信息更全的同主题条目（例如 "QQ 账号 2788…（bot 自身；3916… 是前任）"
    // 比种子 "QQ 账号 2788…（bot 自身）" 更详细）。无条件插入会让两条并存；
    // 更糟的是——用户删掉其中一条后，下次启动种子又把它复活，看起来像「删除无效」。
    // 这里改为：若已存在同前缀（前 10 字符）的条目，就跳过该种子。
    const sameTopic = this.db.prepare("SELECT COUNT(*) c FROM global_facts WHERE substr(content, 1, 10) = ?");
    for (const c of seeds) {
      if (sameTopic.get(c.slice(0, 10)).c > 0) continue;
      ins.run(crypto.createHash("sha256").update(c).digest("hex").slice(0, 16), c);
    }
  }

  // ─────────────────────────── Embedding ───────────────────────────
  get hasEmbedder() { return this._embedder !== null; }

  async _loadEmbedder() {
    if (this._embedPromise) return this._embedPromise;
    this._embedPromise = (async () => {
      const build = async (allowRemote) => {
        const t = await import("@huggingface/transformers");
        // transformers.js 不读 HF_ENDPOINT，需显式设置 remoteHost（hf-mirror，国内可达）
        t.env.remoteHost = process.env.HF_MIRROR ?? "https://hf-mirror.com";
        t.env.allowRemoteModels = allowRemote;
        return t.pipeline("feature-extraction", this.embedModel, {
          dtype: "q8", quantized: true,
          cache_dir: this.modelDir,
        });
      };
      // 加载后必须探一次：个别情况下 pipeline 会「建成功但 tokenizer 不可用」，
      // 必须调用一次才能真正发现，否则后续每次 embed 都报 this.tokenizer is not a function。
      const probe = async (p) => {
        try {
          const o = await p("query: 探测", { pooling: "mean", normalize: true });
          const n = o?.data?.length ?? 0;
          return n >= this._EMB_DIM;
        } catch { return false; }
      };
      try {
        for (const allowRemote of [true, false]) {
          try {
            const cand = await build(allowRemote);
            if (await probe(cand)) { this._embedder = cand; return this._embedder; }
          } catch (e) {
            this._embedError = String(e?.message ?? e);
          }
        }
        throw new Error(this._embedError ?? "pipeline 探测失败");
      } catch (e) {
        this._embedError = String(e?.message ?? e);
        logMem.warn(`embedding 加载失败，降级为关键词检索: ${this._embedError}`);
        this._embedder = null;
      }
      return this._embedder;
    })();
    return this._embedPromise;
  }

  /** 返回归一化 Float32Array（embedding 不可用返回 null）
   *  @param {"query"|"passage"} kind 检索查询用 query、入库用 passage（e5 等模型需前缀） */
  async embed(text, kind = "passage") {
    const e = await this._loadEmbedder();
    if (!e) return null;
    const prefix = kind === "query" ? this.embedPrefixQuery : this.embedPrefixPassage;
    const input = String(prefix + String(text)).slice(0, 320);
    const out = await e(input, { pooling: "mean", normalize: true });
    const arr = Array.isArray(out) ? out[0] : out?.data ?? [];
    // 维度守卫：模型输出必须 ≥ 期望维度，不足则视为不可用（防止静默产生错向量）
    if (!arr || arr.length < this._EMB_DIM) {
      this._embedError = `模型输出维度 ${arr?.length ?? 0} < 期望 ${this._EMB_DIM}（模型 ${this.embedModel} 不匹配）`;
      logMem.warn(this._embedError);
      return null;
    }
    const vec = new Float32Array(this._EMB_DIM);
    for (let i = 0; i < this._EMB_DIM; i++) vec[i] = arr[i];
    return vec;
  }

  static cosine(a, b) {
    if (!a || !b || a.length !== b.length) return 0; // 维度不一致 → 不可比
    let s = 0;
    for (let i = 0; i < a.length; i++) s += a[i] * b[i];
    return s; // 已归一化 → 点积即余弦
  }

  /** 零向量（embedder 不可用时的占位）→ 视为“无向量” */
  static isZeroVec(v) {
    if (!v || !v.length) return true;
    for (let i = 0; i < v.length; i++) if (v[i] !== 0) return false;
    return true;
  }

  static _vecBufToFloat(buf) {
    if (!buf) return null;                     // 空向量 → 不参与相似度
    if (buf instanceof Float32Array) return buf;
    if (buf instanceof Buffer) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (ArrayBuffer.isView(buf)) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    if (buf.buffer instanceof ArrayBuffer) return new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
    return null;
  }

  // ───────────────── 几何校准：去均值(ABTT) + CSLS ─────────────────
  /** 全库均值方向 μ（去均值用）。点数不足或退化时返回 null（退化为原始余弦） */
  _centroid(rows) {
    if (!this.center) return null;
    if (this._mu && !this._geomDirty) return this._mu;
    const dim = this._EMB_DIM;
    const mu = new Float32Array(dim);
    let n = 0;
    for (const r of rows ?? this.db.prepare("SELECT embedding FROM facts").all()) {
      const v = MemoryStore._vecBufToFloat(r.embedding);
      if (!v || MemoryStore.isZeroVec(v)) continue;
      for (let i = 0; i < dim; i++) mu[i] += v[i];
      n++;
    }
    if (n < 8) { this._mu = null; return null; } // 样本太少/过于同质：居中会抹掉信号，退化为原始余弦
    for (let i = 0; i < dim; i++) mu[i] /= n;
    this._mu = mu;
    return mu;
  }

  /** 去均值 + 重新单位化；与均值方向重合（退化）时返回 null */
  static centeredUnit(v, mu) {
    if (!v || !mu) return null;
    const n = v.length;
    const out = new Float32Array(n);
    let s = 0;
    for (let i = 0; i < n; i++) { const d = v[i] - mu[i]; out[i] = d; s += d * d; }
    s = Math.sqrt(s);
    if (!(s > 1e-6)) return null;
    for (let i = 0; i < n; i++) out[i] /= s;
    return out;
  }

  /** 每条事实的「枢纽度」= 它与最近 k 条事实的居中余弦均值（CSLS 的 r_x）。O(n²) 但缓存 */
  _hubScores(items) {
    if (!this.useCsls) return null;
    if (this._hubCache && !this._geomDirty) return this._hubCache;
    if (items.length < 4 || items.length > 1500) return null; // 太小无意义/太大放弃
    const k = Math.min(this.cslsK, items.length - 1);
    const map = new Map();
    const buf = new Float64Array(items.length);
    for (let i = 0; i < items.length; i++) {
      let c = 0;
      for (let j = 0; j < items.length; j++) {
        if (i === j) continue;
        const s = MemoryStore.cosine(items[i].v, items[j].v);
        if (c < k) { buf[c++] = s; }
        else { // 维持 top-k（插入排序，k 很小）
          let min = 0;
          for (let m = 1; m < k; m++) if (buf[m] < buf[min]) min = m;
          if (s > buf[min]) buf[min] = s;
        }
      }
      let sum = 0;
      for (let m = 0; m < c; m++) sum += buf[m];
      map.set(items[i].id, c ? sum / c : 0);
    }
    this._hubCache = map;
    return map;
  }

  /** 构建全部可向量化条目（居中后的单位向量） */
  _vectorItems(mu) {
    const rows = this.db.prepare("SELECT id, embedding FROM facts").all();
    const items = [];
    for (const r of rows) {
      const v = MemoryStore._vecBufToFloat(r.embedding);
      if (!v || MemoryStore.isZeroVec(v)) continue;
      const cv = mu ? MemoryStore.centeredUnit(v, mu) : v;
      if (cv) items.push({ id: r.id, v: cv });
    }
    return items;
  }

  // ─────────────────────────── 写入: 自动收割 ───────────────────────────
  /**
   * 收割（异步、节流、不阻塞回复）。userText/botText 为最近一轮内容
   * @param {string[]} [priorIds] 上一轮注入进上下文的记忆 id（用于回传「真被用到」的信号）
   */
  /**
   * 收割：把对话里的事实抽进长期记忆。
   *
   * 【调用时机：压缩之前，只在这一处】
   * 历史被压缩丢弃的那一刻，是这些内容最后一次可见的机会 —— 也正因如此，
   * 收割输入是**完整上下文**（pi 的会话消息数组），而不是某一轮的文本。
   * 早先每轮结束都跑一次 + 10 分钟节流，既重复劳动（内容还在，下轮还会扫到）
   * 又会漏（关键信息落在被节流掉的那轮就再没机会）。
   *
   * @param {{session:string, userId:string, chatType:string, targetId?:string,
   *          messages?:Array, userText?:string, botText?:string, priorIds?:string[]}} opts
   */
  async harvest({ session, userId, chatType, targetId, messages, userText, botText, priorIds }) {
    if (!session || !userId) return { ok: false, reason: "no-ctx" };
    const hasMessages = Array.isArray(messages) && messages.length > 0;
    if (!hasMessages && !userText && !botText) return { ok: false, reason: "empty" };

    const row = this.db.prepare("SELECT ts FROM harvest_log WHERE session = ? ORDER BY ts DESC LIMIT 1").get(session);
    const now = Date.now();
    // 节流（默认关：0 表示不节流）。因为收割已收敛到「压缩前一次」，
    // 调用频率本身就极低，节流只在需要时才开（如手动批量场景）。
    if (this.harvestIntervalMs > 0 && row && now - row.ts < this.harvestIntervalMs) {
      return { ok: false, reason: "throttled" };
    }
    if (this._harvesting.has(session)) return { ok: false, reason: "busy" };
    this._harvesting.add(session);
    try {
      const priors = Array.isArray(priorIds) ? priorIds.slice(0, 40) : [];
      // 完整上下文 → 对话文本（已在 renderDialogs 里剥掉注入的记忆块、丢弃工具输出）
      const dialogsText = hasMessages
        ? MemoryStore.renderDialogs(messages, {
            budgetChars: Number(this.harvestDialogsChars ?? 20000),
          })
        : `用户: ${String(userText ?? "").slice(0, 1500)}\n助手: ${String(botText ?? "").slice(0, 1500)}`;
      if (!String(dialogsText).trim()) return { ok: true, count: 0, used: 0 };
      // 已知事实清单（第二道防重复：光剥注入块挡不住用户复述/换个说法）
      const source = memorySourceOf({ chatType, userId, targetId }) ?? `private:${userId}`;
      let knownFacts = [];
      try {
        knownFacts = this.db
          .prepare("SELECT content FROM facts WHERE source = ? AND valid_until IS NULL ORDER BY ts DESC LIMIT 60")
          .all(source)
          .map((r) => r.content);
      } catch {
        /* 取不到就不给清单 */
      }
      const out = await this._extract({ dialogsText, priorIds: priors, knownFacts });
      const facts = Array.isArray(out?.facts) ? out.facts : [];
      const usedIds = (Array.isArray(out?.used_ids) ? out.used_ids : [])
        .map((x) => String(x).slice(0, 64))
        .filter((id) => priors.includes(id));
      if (usedIds.length) this.markUsed(usedIds);
      if (!facts.length) {
        this._logHarvest(session, userId, now, 0, { facts: [], usedIds });
        return { ok: true, count: 0, used: usedIds.length };
      }
      let n = 0;
      for (const f of facts) {
        // 自主永久记忆：偏好/承诺类自动 pinned（不参与 LRU 淘汰，永久保留）
        const autoPinned = f?.type === "pref" || f?.type === "promise" ? 1 : 0;
        n += await this._upsertFact(f, source, autoPinned);
      }
      this._logHarvest(session, userId, now, n, { facts, usedIds });
      this._evict();
      return { ok: true, count: n, used: usedIds.length };
    } catch (e) {
      logMem.error(`收割失败: ${e?.message}`);
      return { ok: false, reason: "error" };
    } finally {
      this._harvesting.delete(session);
    }
  }

  /**
   * 把一组已抽好的事实写入记忆库（供**合并压缩**路径使用）。
   *
   * 【为什么单独开一个公开方法】合并压缩（session_before_compact 钩子）里，
   * 摘要与事实由同一次模型调用产出，事实已经拿到手，不需要再走 harvest 的
   * 「渲染上下文 → 调模型抽取」全流程。直接落库即可，但要复用 _upsertFact
   * 的去重/合并规则 —— 否则两条写入路径的分类规则会漂移。
   *
   * @param {{facts:Array, usedIds?:string[], chatType?:string, userId:string, targetId?:string}} o
   * @returns {Promise<number>} 实际写入（含合并更新）的条数
   */
  async writeFacts({ facts, usedIds, chatType, userId, targetId }) {
    if (!Array.isArray(facts) || !facts.length || !userId) return 0;
    const source = memorySourceOf({ chatType, userId, targetId }) ?? `private:${userId}`;
    let n = 0;
    for (const f of facts) {
      // 自主永久记忆：偏好/承诺类自动 pinned（与 harvest 规则一致）
      const autoPinned = f?.type === "pref" || f?.type === "promise" ? 1 : 0;
      n += await this._upsertFact(f, source, autoPinned);
    }
    if (Array.isArray(usedIds) && usedIds.length) {
      try {
        this.markUsed(usedIds);
      } catch {
        /* ignore */
      }
    }
    try {
      this._evict();
    } catch {
      /* ignore */
    }
    return n;
  }

  _logHarvest(session, userId, ts, count, detail) {
    this.db.prepare("INSERT INTO harvest_log (session, user_id, ts, count, detail) VALUES (?, ?, ?, ?, ?)")
      .run(session, userId, ts, count, JSON.stringify(detail ?? []));
  }

  static get EXTRACT_PROMPT() {
    return loadPrompt("memory", "harvest.md");
  }

  /** 注入块的起始标记。剥离时必须与构造处用同一套字面量，
   *  否则改了一处忘了另一处，注入的记忆又会被当成新事实收割回来。 */
  static INJECT_MARKERS = ["【全局】", "【记忆】"];

  /**
   * 从一段对话文本里剥掉**我们自己注入的记忆块**（【全局】/【记忆】）。
   *
   * 【这道防线现在的定位：防回归，而不是主力】
   * 当前实现里，注入走的是 before_provider_request，只改**线上报文**、不写回会话，
   * 因此从会话文件重建上下文时本来就看不到注入块 —— 对压缩路径它近似空操作。
   *
   * 保留它的理由有两个：
   *   1) 历史里有旧方案留下的少量残留（注入曾写在消息里），剥掉不亏；
   *   2) 万一将来有人把注入改回「写入历史」，这道防线能避免自我吞噬
   *      —— 把已有记忆当新事实反复抽取，条目越滚越多、语义高度重复。
   *
   * 【真正防重复的是「已知事实清单」】见下面 _extract 的 knownFacts：
   * 它挡的是与注入块无关的那一类重复（用户复述、换个说法说同一件事）。
   *
   * 剥离规则：从任一标记独占一行处起，到文本末尾（注入块永远在末尾），
   * 整段丢掉。若标记出现在中间（异常情形），只切到该行结束，避免误删大量正文。
   *
   * @param {string} text
   * @returns {string}
   */
  static stripInjectedBlocks(text) {
    let t = String(text ?? "");
    for (const m of MemoryStore.INJECT_MARKERS) {
      const i = t.indexOf(m);
      if (i < 0) continue;
      // 标记在行首（允许前导空白）→ 视为注入块起点
      const lineStart = t.lastIndexOf("\n", i) + 1;
      const prefix = t.slice(lineStart, i);
      if (prefix.trim() === "") {
        t = t.slice(0, lineStart); // 注入块在末尾：整段切掉
      } else {
        // 标记夹在正文中：保守起见只切到该行结束，避免连带删掉后面的真实对话
        const lineEnd = t.indexOf("\n", i);
        t = lineEnd < 0 ? t.slice(0, i) : t.slice(0, i) + t.slice(lineEnd);
      }
    }
    return t.trim();
  }

  /** 收割用的 LLM 调用：返回 { facts:[...], used_ids:[...] } */
  /**
   * 把 pi 的会话消息数组渲染成「用户/助手/工具」对话文本（供收割）。
   *
   * 【为什么按消息数组而不是单轮文本】
   * 收割已从「每轮结束」改为「压缩时」。压缩面对着的是**整段即将被丢弃的历史**，
   * 单轮文本远远不够 —— 那才是真正需要抢救的内容。
   *
   * 【必须剥掉注入块】每条 user 消息尾部可能挂着我们注入的【全局】/【记忆】块，
   * 那是已有记忆的原文，不剥就会被当成新事实反复抽取（自我吞噬）。
   *
   * 【工具结果怎么处理】toolResult 往往是几百 KB 的命令输出 / 文件内容，
   * 对「提取长期事实」价值极低却极占预算 —— 只取极短摘要，且默认丢弃。
   *
   * @param {Array} messages pi 会话消息
   * @param {{budgetChars?:number, includeTools?:boolean}} [opts]
   * @returns {Array<{role:string, text:string}>}
   */
  static renderDialogs(messages, { budgetChars = 20000, includeTools = false } = {}) {
    const out = [];
    for (const m of Array.isArray(messages) ? messages : []) {
      const role = String(m?.role ?? "");
      if (role === "system") continue;
      const c = m?.content;
      let text = "";
      if (typeof c === "string") {
        text = c;
      } else if (Array.isArray(c)) {
        for (const part of c) {
          if (!part || typeof part !== "object") continue;
          const pt = String(part.type ?? "");
          if (pt === "text") text += String(part.text ?? "");
          else if (pt === "image") text += "〔图片〕";
          else if (pt === "toolCall" || pt === "tool_use") text += `〔调用工具 ${part.name ?? part.toolName ?? "?"}〕`;
        }
      }
      // 注入块可能出现在任何角色上（注入挂在报文最后一条），一律剥掉
      text = MemoryStore.stripInjectedBlocks(text);
      if (role === "toolResult" || role === "tool") {
        if (!includeTools) continue; // 默认丢弃工具输出（低价值、高体积）
        text = text.slice(0, 200);
      }
      if (!text.trim()) continue;
      out.push({ role, text });
    }
    // 超预算 → 保留**靠后**的部分：越近的内容越可能仍然有效
    const per = 1200;
    const blocks = out.map((d) => {
      const who = d.role === "user" ? "用户" : d.role === "assistant" ? "助手" : d.role;
      const t = d.text.length > per ? d.text.slice(0, per) + "…" : d.text;
      return `${who}: ${t}`;
    });
    let joined = blocks.join("\n");
    if (joined.length > budgetChars) {
      joined = joined.slice(-budgetChars);
      joined = "（前文已省略）…\n" + joined;
    }
    return joined;
  }

  /**
   * 收割用的 LLM 调用：返回 { facts:[...], used_ids:[...] }
   *
   * @param {{dialogsText:string, priorIds?:string[], knownFacts?:string[]}} opts
   */
  async _extract({ dialogsText, priorIds = [], knownFacts = [] }) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return { facts: [] };
    const priorBlock = priorIds.length
      ? `\n\n[上一轮注入给助手的记忆条目 id]\n${priorIds.map((id) => `- ${id}`).join("\n")}`
      : "";
    // 【已知事实清单】把库里已有的相关记忆摘要一并给出，明确要求「不要重复输出这些」。
    // 仅靠「剥掉注入块」还不够 —— 对话里用户复述过的事实，或换句话说的同一件事，
    // 仍会被抽成新条目。给出清单是第二道防线，也让 used_ids 的指认有依据。
    const knownBlock = knownFacts.length
      ? `\n\n[库里已有的事实（**不要重复输出这些**，内容相同或明显同义的一律跳过）]\n` +
        knownFacts.map((k) => `- ${String(k).slice(0, 120)}`).join("\n")
      : "";
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.harvestModel,
        messages: [
          { role: "system", content: MemoryStore.EXTRACT_PROMPT },
          { role: "user", content: `[对话]\n${dialogsText}` + knownBlock + priorBlock },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`harvest http ${resp.status}`);
    const d = await resp.json();
    const txt = d?.choices?.[0]?.message?.content ?? "{}";
    const obj = JSON.parse(txt);
    return {
      facts: Array.isArray(obj?.facts) ? obj.facts.slice(0, 10) : [],
      used_ids: Array.isArray(obj?.used_ids) ? obj.used_ids : [],
    };
  }

  /** 反思用的 LLM 调用（Generative Agents reflection / Letta sleep-time） */
  async _synthesize(material, existing = []) {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) return [];
    const prompt = loadPrompt("memory", "reflect.md");
    if (!prompt) return [];
    const resp = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({
        model: this.harvestModel,
        messages: [
          { role: "system", content: prompt },
          {
            role: "user",
            content:
              `[已有洞见（不要重复）]\n${existing.map((e) => "- " + String(e.content).slice(0, 200)).join("\n") || "（无）"}\n\n` +
              `[待归纳的事实]\n${material.map((m) => `- [${m.type}] ${String(m.content).slice(0, 300)}`).join("\n")}`,
          },
        ],
        temperature: 0,
        response_format: { type: "json_object" },
      }),
      signal: AbortSignal.timeout(60000),
    });
    if (!resp.ok) throw new Error(`reflect http ${resp.status}`);
    const d = await resp.json();
    const obj = JSON.parse(d?.choices?.[0]?.message?.content ?? "{}");
    return Array.isArray(obj?.insights) ? obj.insights.slice(0, 5) : [];
  }

  /**
   * 反思：把零散事实（+ 既有洞见）合成为更高层洞见，存为 type='reflection'（pinned、高重要性）。
   * @returns {{created:number, insights:Array}}
   */
  async reflect({ source, hours = 24 * 14, limit = 80, log = () => {} } = {}) {
    const since = Date.now() - hours * 3600000;
    const rows = this.db
      .prepare("SELECT id, type, content, tags, source, ts FROM facts WHERE valid_until IS NULL AND ts >= ? ORDER BY ts DESC LIMIT ?")
      .all(since, limit)
      .filter((r) => !source || this._sourceMatch(r.source, source));
    const material = rows.filter((r) => r.type !== "reflection");
    if (material.length < 5) return { created: 0, insights: [], reason: "素材不足" };
    const existing = this.db.prepare("SELECT content FROM facts WHERE type = 'reflection' AND valid_until IS NULL").all();
    const insights = await this._synthesize(material, existing);
    let created = 0;
    for (const ins of insights) {
      const content = MemoryStore._cleanContent(ins?.content ?? ins?.insight ?? "");
      if (!content) continue;
      const n = await this._upsertFact(
        { content, type: "reflection", importance: Number(ins?.importance ?? 8), tags: ["reflection"] },
        source ?? "seed",
        1
      );
      if (n) { created++; log(`  + ${content.slice(0, 60)}`); }
    }
    return { created, insights };
  }

  /** 内容预处理：压缩空白、过滤纯符号/超短碎片 */
  static _cleanContent(raw) {
    let c = String(raw ?? "").replace(/\s+/g, " ").trim();
    c = c.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, "").trim(); // 去 emoji
    if (c.length < 3) return "";                    // 超短碎片丢弃
    if (!/[\u4e00-\u9fff\u0041-\u005a\u0061-\u007a\u0030-\u0039]/.test(c)) return ""; // 无中英数字
    return c.slice(0, 512);
  }

  /** 词面相似：字符二元组 Jaccard（判断「同一断言的复述」还是「换了值的矛盾」） */
  static _lexSim(a, b) {
    const grams = (s) => {
      const t = String(s).replace(/[\s\p{P}]/gu, "");
      const set = new Set();
      for (let i = 0; i + 1 < t.length; i++) set.add(t.slice(i, i + 2));
      if (!set.size && t) set.add(t);
      return set;
    };
    const A = grams(a), B = grams(b);
    if (!A.size || !B.size) return 0;
    let inter = 0;
    for (const g of A) if (B.has(g)) inter++;
    return inter / (A.size + B.size - inter);
  }

  /** 提取内容里的「数值槽位」（IP/端口/版本/尺寸/模型名里的数字） */
  static _numericTokens(s) {
    return new Set(String(s).match(/\d+(?:\.\d+)*/g) ?? []);
  }

  /** 规范化（去空白与标点、转小写），用于词面判断 */
  static _norm(s) {
    return String(s ?? "").replace(/[\s\p{P}]/gu, "").toLowerCase();
  }

  /**
   * 字面命中：短查询直接子串；长查询改用「内容被查询覆盖的比例」（二元组），
   * 否则注入时把整条用户消息当关键词去 includes 永远不命中。
   */
  static _lexHit(query, content, tags) {
    const q = MemoryStore._norm(query);
    if (!q) return false;
    const c = MemoryStore._norm(content);
    if (q.length >= 2 && c.includes(q)) return true;
    if (String(tags ?? "").toLowerCase().includes(q)) return true;
    if (q.length < 6) return false;                 // 短词只认子串
    const grams = new Set();
    for (let i = 0; i + 1 < c.length; i++) grams.add(c.slice(i, i + 2));
    if (!grams.size) return false;
    let hit = 0;
    for (const g of grams) if (q.includes(g)) hit++;
    return hit / grams.size >= 0.75;                // 内容大部分字面出现在查询里
  }

  static _sameNumbers(a, b) {
    const A = MemoryStore._numericTokens(a), B = MemoryStore._numericTokens(b);
    if (A.size !== B.size) return false;
    for (const x of A) if (!B.has(x)) return false;
    return true;
  }

  /** 把旧内容存进 fact_history（覆盖/失效前留痕） */
  _archiveVersion(row, reason) {
    this.db
      .prepare("INSERT INTO fact_history (fact_id, content, ts, replaced_at, reason) VALUES (?, ?, ?, ?, ?)")
      .run(row.id, String(row.content), Number(row.ts ?? Date.now()), Date.now(), reason);
  }

  /** 最近的同类型近邻（居中余弦），用于合并/覆盖判定 */
  async _nearestSameType(emb, type, excludeId = null) {
    const rows = type
      ? this.db.prepare("SELECT id, content, tags, embedding, type FROM facts WHERE type = ? AND valid_until IS NULL").all(type)
      : this.db.prepare("SELECT id, content, tags, embedding, type FROM facts WHERE valid_until IS NULL").all();
    let best = null;
    const mu = this._centroid();
    const q = mu ? MemoryStore.centeredUnit(emb, mu) : emb;
    if (!q) return null;
    for (const row of rows) {
      if (excludeId && row.id === excludeId) continue;
      const fb = MemoryStore._vecBufToFloat(row.embedding);
      if (!fb || MemoryStore.isZeroVec(fb)) continue;
      const cv = mu ? MemoryStore.centeredUnit(fb, mu) : fb;
      if (!cv) continue;
      const sim = MemoryStore.cosine(q, cv);
      if (!best || sim > best.sim) best = { row, sim };
    }
    return best;
  }

  /**
   * 单条事实 upsert。
   *  1) 同 id（type+content 精确重复）→ 刷新
   *  2) 同类型居中相似度 ≥ mergeSim：
   *     · 数值集合相同 → 同一断言的复述/富化：取更长内容，同步向量
   *     · 数值集合不同 → 同一槽位换了值（IP/端口/版本/模型名等）：新信息优先，覆盖内容并留痕
   *  3) [relatedSim, mergeSim) → 相关但不同，新增
   *  4) 其它 → 新增
   *  重要：embedder 不可用时仍然写入（零向量占位，检索降级为关键词），绝不静默丢弃。
   */
  async _upsertFact(f, source, pinned = 0) {
    const allowed = ["pref", "fact", "promise", "event", "deploy", "reflection"];
    const type = allowed.includes(f?.type) ? f.type : "fact";
    const content = MemoryStore._cleanContent(f?.content ?? "");
    if (!content) return 0;
    const id = crypto.createHash("sha256").update(type + content).digest("hex").slice(0, 16);
    const tags = JSON.stringify(Array.isArray(f?.tags) ? f.tags.map(String).slice(0, 10) : []);
    const sensitive = f?.sensitive ? 1 : 0;
    const impRaw = Number(f?.importance);
    const importance = Number.isFinite(impRaw) ? Math.max(1, Math.min(10, Math.round(impRaw))) : 5;
    const ts = Date.now();
    const emb = await this.embed(content, "passage");
    const buf = emb ? Buffer.from(emb.buffer) : Buffer.alloc(this._EMB_DIM * 4);

    const existing = this.db.prepare("SELECT id, content, tags FROM facts WHERE id = ?").get(id);
    if (existing) {
      this._mergeInto(existing, { content, tags, buf, source, pinned, sensitive, ts, importance, reason: "dup" });
      this._markGeomDirty();
      return 1;
    }

    if (emb) {
      const mu = this._centroid();
      // 没有居中（库太小）时，「原始余弦」有 ~0.87 的噪声地板，阈值不可直接用，
      // 只能靠极高相似度（近乎逐字相同）才允许合并。
      const effMerge = mu ? this.mergeSim : Math.max(this.mergeSim, 0.95);
      // 先在同类型里找；同类型无命中时，允许跨类型合并（需更高相似度，避免误并）
      let near = await this._nearestSameType(emb, type);
      if (mu && (!near || near.sim < this.mergeSim)) {
        const cross = await this._nearestSameType(emb, null);
        if (cross && cross.sim >= this.mergeSim + 0.06) near = cross;
      }
      if (near && near.sim >= effMerge) {
        const old = near.row;
        const sameNums = MemoryStore._sameNumbers(old.content, content);
        const lex = MemoryStore._lexSim(old.content, content);
        // 「同一槽位换值」：两边都有数字、说法很像（lex 高）、但数字集合不同 → 新值优先，旧断言失效留痕
        const slotChanged =
          !sameNums && lex >= 0.4 &&
          MemoryStore._numericTokens(old.content).size > 0 &&
          MemoryStore._numericTokens(content).size > 0;
        if (this.autoSupersede && slotChanged) {
          this._archiveVersion(old, "superseded-by-new-value");
          this.db
            .prepare("UPDATE facts SET valid_until = ?, superseded_by = ? WHERE id = ?")
            .run(ts, id, old.id);
          this._markGeomDirty();
          this.db.prepare(
            "INSERT INTO facts (id, type, content, tags, source, ts, lastUsed, pinned, sensitive, embedding, importance, valid_from, valid_until) " +
            "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
          ).run(id, type, content, tags, source, ts, ts, pinned, sensitive, buf, importance, ts);
          return 1;
        }
        // 其余高相似：视为同一断言的复述/富化，保留信息更多的那个（内容与向量同步更新）
        this._mergeInto(old, {
          content: content.length > String(old.content).length ? content : String(old.content),
          tags, buf, source, pinned, sensitive, ts, importance, reason: "enrich",
        });
        this._markGeomDirty();
        return 1;
      }
    }

    this.db.prepare(
      "INSERT INTO facts (id, type, content, tags, source, ts, lastUsed, pinned, sensitive, embedding, importance, valid_from, valid_until) " +
      "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)"
    ).run(id, type, content, tags, source, ts, ts, pinned, sensitive, buf, importance, ts);
    this._markGeomDirty();
    return 1;
  }

  /** 主动永久记忆：普通记忆 pinned（不淘汰）或全局常驻（每次会话注入）。 */
  async remember({ content, type = "fact", source = "seed", pinned = false, global = false, tags, importance }) {
    const raw = String(content ?? "");
    const clean = MemoryStore._cleanContent(raw);
    if (!clean) {
      return { ok: false, error: raw.trim() ? "内容过短/无有效字符（需 ≥3 字且含中英文或数字）" : "内容为空" };
    }
    try {
      if (global) {
        const id = crypto.createHash("sha256").update(clean).digest("hex").slice(0, 16);
        this.db.prepare("INSERT OR IGNORE INTO global_facts (id, content, enabled) VALUES (?, ?, 1)").run(id, clean);
        return { ok: true, id, global: true };
      }
      const t = ["pref", "fact", "promise", "event", "deploy", "reflection"].includes(type) ? type : "fact";
      const n = await this._upsertFact({ content: clean, type: t, tags, importance }, source, pinned ? 1 : 0);
      const id = crypto.createHash("sha256").update(t + clean).digest("hex").slice(0, 16);
      if (n > 0) return { ok: true, id, degraded: this._embedder ? undefined : true };
      return { ok: false, error: "写入未生效（内容被判定为无效）" };
    } catch (e) {
      logMem.error(`remember 异常: ${e?.message}`);
      return { ok: false, error: `写入异常: ${e?.message ?? e}` };
    }
  }

  /** embedder 状态（供 /mem status 与排障） */
  embedderState() {
    return { ready: !!this._embedder, model: this.embedModel, dim: this._EMB_DIM, error: this._embedError ?? null, modelDir: this.modelDir };
  }

  /** 几何状态（均值方向/枢纽缓存是否就绪） */
  geometryState() {
    const mu = this._centroid();
    return {
      center: this.center,
      csls: this.useCsls,
      centroidReady: !!mu,
      centroidNorm: mu ? Math.sqrt(MemoryStore.cosine(mu, mu)) : null,
      thresholds: { mergeSim: this.mergeSim, relatedSim: this.relatedSim, gateSim: this.gateSim, gateRel: this.gateRel },
      weights: this.weights,
    };
  }

  /** 找出近似重复对（> 阈值，居中空间），供人工确认；不自动删 */
  findDuplicates(threshold = this.mergeSim) {
    const mu = this._centroid();
    const rows = this.db.prepare("SELECT id, content, embedding FROM facts WHERE valid_until IS NULL").all();
    const vs = [];
    for (const r of rows) {
      const b = MemoryStore._vecBufToFloat(r.embedding);
      if (!b || MemoryStore.isZeroVec(b)) continue;
      const v = mu ? MemoryStore.centeredUnit(b, mu) : b;
      if (v) vs.push({ id: r.id, c: String(r.content), v });
    }
    const out = [];
    for (let i = 0; i < vs.length; i++) for (let j = i + 1; j < vs.length; j++) {
      const sim = MemoryStore.cosine(vs[i].v, vs[j].v);
      if (sim > threshold) out.push({ sim, a: vs[i], b: vs[j] });
    }
    return out.sort((x, y) => y.sim - x.sim);
  }

  /** 实测当前向量空间的分布（原始余弦 vs 居中余弦），用于校准阈值 */
  calibrate({ sample = 4000, full = false } = {}) {
    const mu = this._centroid();
    const rows = this.db.prepare("SELECT id, content, embedding FROM facts").all();
    const raw = [], cen = [];
    const vs = [];
    for (const r of rows) {
      const b = MemoryStore._vecBufToFloat(r.embedding);
      if (!b || MemoryStore.isZeroVec(b)) continue;
      const cv = mu ? MemoryStore.centeredUnit(b, mu) : b;
      vs.push({ id: r.id, c: String(r.content), raw: b, cen: cv });
    }
    let pairs = 0;
    for (let i = 0; i < vs.length && pairs < sample; i++) {
      for (let j = i + 1; j < vs.length && pairs < sample; j++) {
        raw.push(MemoryStore.cosine(vs[i].raw, vs[j].raw));
        if (vs[i].cen && vs[j].cen) cen.push(MemoryStore.cosine(vs[i].cen, vs[j].cen));
        pairs++;
      }
    }
    const st = (arr) => {
      if (!arr.length) return null;
      const s = [...arr].sort((a, b) => a - b);
      const q = (p) => s[Math.min(s.length - 1, Math.floor(s.length * p))];
      return {
        n: s.length,
        min: +s[0].toFixed(4), p50: +q(0.5).toFixed(4), p90: +q(0.9).toFixed(4),
        p95: +q(0.95).toFixed(4), p99: +q(0.99).toFixed(4), max: +s[s.length - 1].toFixed(4),
      };
    };
    const r = st(raw), c = st(cen);
    return {
      facts: vs.length,
      pairs: r?.n ?? 0,
      rawStats: r,
      centeredStats: c,
      raw: full ? raw : undefined,
      centered: full ? cen : undefined,
      suggest: c
        ? {
            // gate 取「随机对余弦」的 p95 上方：超过它才算真信号（本库实测 ≈0.20）
            gateSim: +(c.p95 + 0.02).toFixed(2),
            // merge 取全库最大对相似度上方：保证「同断言复述」才会触发融合
            mergeSim: +Math.min(0.9, Math.max(0.45, c.max + 0.05)).toFixed(2),
          }
        : null,
    };
  }

  /** 合并重复：**只合并「同一条断言的复述」**（高相似 + 词面很像或互相包含），
   *  相关但信息不同的保留两条，不丢信息。 */
  dedupe(threshold = this.mergeSim, log = () => {}) {
    const dups = this.findDuplicates(threshold);
    let removed = 0, skipped = 0;
    const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
    const setContent = this.db.prepare("UPDATE facts SET content = ? WHERE id = ?");
    const gone = new Set();
    for (const d of dups) {
      if (gone.has(d.a.id) || gone.has(d.b.id)) continue;
      const na = MemoryStore._norm(d.a.c), nb = MemoryStore._norm(d.b.c);
      const contained = na.includes(nb) || nb.includes(na);
      const lex = MemoryStore._lexSim(d.a.c, d.b.c);
      if (!contained && lex < 0.45) {
        skipped++;
        log(`  跳过（相关但不同）${d.sim.toFixed(3)} lex=${lex.toFixed(2)}: 「${d.a.c.slice(0, 22)}…」 vs 「${d.b.c.slice(0, 22)}…」`);
        continue;
      }
      const [keep, drop] = d.a.c.length >= d.b.c.length ? [d.a, d.b] : [d.b, d.a];
      del.run(drop.id);
      setContent.run(keep.c, keep.id);
      gone.add(drop.id);
      removed++;
      log(`  合并 ${d.sim.toFixed(3)}: 保留「${keep.c.slice(0, 26)}…」删除「${drop.c.slice(0, 26)}…」`);
    }
    this._markGeomDirty();
    return { scanned: dups.length, removed, skipped };
  }

  /**
   * 合并写入：**content 与 embedding 必须同步更新**（早期实现只写新向量、留旧内容，
   * 会造出「内容 A / 向量 B」的错配脏数据，导致检索命中错误条目）。
   */
  _mergeInto(row, { content, tags, buf, source, pinned, sensitive, ts, importance, reason = "merge" }) {
    const oldContent = String(row?.content ?? "");
    const takeNew = content.length > oldContent.length;
    if (takeNew && buf) {
      this.db.prepare(
        "UPDATE facts SET content = ?, tags = ?, lastUsed = ?, sensitive = MAX(sensitive, ?), source = ?, embedding = ?, " +
        "pinned = MAX(pinned, ?), importance = MAX(importance, ?), superseded_by = NULL, valid_until = NULL WHERE id = ?"
      ).run(content, tags, ts, sensitive, source, buf, pinned, importance ?? 5, row.id);
      return;
    }
    this.db.prepare(
      "UPDATE facts SET tags = ?, lastUsed = ?, sensitive = MAX(sensitive, ?), source = ?, " +
      "pinned = MAX(pinned, ?), importance = MAX(importance, ?), superseded_by = NULL, valid_until = NULL WHERE id = ?"
    ).run(tags, ts, sensitive, source, pinned, importance ?? 5, row.id);
    void reason;
  }

  /** 一致性自检：找出「向量与内容不匹配」的行（用当前模型重算后比对），并在 fix=true 时修复 */
  async verifyConsistency(fix = false, log = () => {}) {
    const rows = this.db.prepare("SELECT id, content, embedding FROM facts").all();
    let bad = 0, checked = 0;
    const upd = this.db.prepare("UPDATE facts SET embedding = ? WHERE id = ?");
    for (const r of rows) {
      const fresh = await this.embed(r.content, "passage");
      if (!fresh) break; // embedder 不可用 → 无法自检
      const cur = MemoryStore._vecBufToFloat(r.embedding);
      const sim = cur && !MemoryStore.isZeroVec(cur) ? MemoryStore.cosine(fresh, cur) : 0;
      checked++;
      if (sim < 0.999) {
        bad++;
        log(`  ✗ ${r.id} 内容与向量不符(cos=${sim.toFixed(4)}): ${String(r.content).slice(0, 40)}`);
        if (fix) upd.run(Buffer.from(fresh.buffer), r.id);
      }
    }
    if (fix) this._markGeomDirty();
    return { checked, bad, fixed: fix ? bad : 0 };
  }

  /** 重建全部向量（换模型/修复维度不一致后调用）；返回 {total, ok, fail} */
  async reembedAll(log = () => {}) {
    const rows = this.db.prepare("SELECT id, type, content FROM facts").all();
    let ok = 0, fail = 0;
    const upd = this.db.prepare("UPDATE facts SET embedding = ? WHERE id = ?");
    for (const r of rows) {
      const emb = await this.embed(r.content, "passage");
      if (!emb) { fail++; continue; }
      upd.run(Buffer.from(emb.buffer), r.id);
      ok++;
      if (ok % 10 === 0) log(`  已重嵌 ${ok}/${rows.length}`);
    }
    this._markGeomDirty();
    return { total: rows.length, ok, fail };
  }

  // ─────────────────────────── 淘汰 ───────────────────────────
  /** 记忆强度 S（MemoryBank：初次为 1，每次被想起 +1；重要性再加权） */
  static _strength(r) {
    return 1 + (r.useCount ?? 0) + (r.importance ?? 5) / 2;
  }

  /** 保留率 R = e^(-Δt/S)（艾宾浩斯遗忘曲线；Δt 为距上次使用的天数） */
  static _retention(r, now = Date.now()) {
    const last = Math.max(r.lastUsed || 0, r.ts || 0);
    const days = Math.max(0, (now - last) / 86400000);
    return Math.exp(-days / MemoryStore._strength(r));
  }

  /** 超上限淘汰：pinned 除外；默认按遗忘曲线保留率升序淘汰（可切回 LRU） */
  _evict() {
    const total = this.db.prepare("SELECT COUNT(*) c FROM facts WHERE pinned = 0").get().c;
    const over = total - this.maxFacts;
    if (over <= 0) return;
    let rows;
    if (this.evictMode === "lru") {
      rows = this.db.prepare("SELECT * FROM facts WHERE pinned = 0 ORDER BY lastUsed ASC LIMIT ?").all(over);
    } else {
      const now = Date.now();
      rows = this.db
        .prepare("SELECT * FROM facts WHERE pinned = 0")
        .all()
        .map((r) => ({ r, keep: MemoryStore._retention(r, now) }))
        .sort((a, b) => a.keep - b.keep)
        .slice(0, over)
        .map((x) => x.r);
    }
    const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
    const arch = this.db.prepare(
      "INSERT OR IGNORE INTO evicted_facts (id, type, content, source, ts, evicted_at, use_count) VALUES (?, ?, ?, ?, ?, ?, ?)"
    );
    const now = Date.now();
    for (const r of rows) {
      arch.run(r.id, r.type, r.content, r.source, r.ts, now, r.useCount);
      del.run(r.id);
    }
    this._markGeomDirty();
    logMem.info(`淘汰并归档 ${rows.length} 条（超出上限 ${this.maxFacts}，模式 ${this.evictMode}）`);
  }

  /** 归档历史（CLI 查看） */
  evicted() {
    return this.db.prepare("SELECT * FROM evicted_facts ORDER BY evicted_at DESC LIMIT 100").all();
  }

  /** 被新事实覆盖的旧版本（CLI 查看） */
  history(factId = null) {
    return factId
      ? this.db.prepare("SELECT * FROM fact_history WHERE fact_id = ? ORDER BY replaced_at DESC").all(factId)
      : this.db.prepare("SELECT * FROM fact_history ORDER BY replaced_at DESC LIMIT 100").all();
  }

  /** 当前已失效（被覆盖）的事实 */
  superseded() {
    return this.db
      .prepare("SELECT id, type, content, source, ts, valid_until, superseded_by FROM facts WHERE valid_until IS NOT NULL ORDER BY valid_until DESC LIMIT 100")
      .all();
  }

  // ─────────────────────────── 读取: 混合检索注入 ───────────────────────────
  /**
   * 检索记忆（search 工具 + 注入共用）
   * 打分（Generative Agents 式，候选集内各自 min-max 归一后加权）：
   *   score = 3.0·相关性 + 2.0·重要性 + 0.5·新近性 + 1.5·字面命中 + 0.5·pinned
   * 相关性用「居中余弦 + CSLS 局部密度惩罚」；另有绝对门槛 gateSim 过滤不相关项。
   * @param {{keyword?, timeFrom?, timeTo?, source?, type?, limit?, chatType?, markUsed?, includeInvalid?}} q
   */
  async search(q = {}) {
    const {
      keyword, timeFrom, timeTo, source, type, limit = 10, chatType = "private",
      markUsed = false, includeInvalid = false,
    } = q;
    const all = this.db.prepare("SELECT * FROM facts").all();
    // 有效性过滤（Graphiti：默认只看当前有效断言）
    let rows = all.filter((r) => includeInvalid || r.valid_until == null);
    const tFrom = timeFrom ? new Date(timeFrom).getTime() : null;
    const tTo = timeTo ? new Date(timeTo).getTime() : null;
    rows = rows.filter((r) => {
      if (type && r.type !== type) return false;
      if (tFrom !== null && r.ts < tFrom) return false;
      if (tTo !== null && r.ts > tTo) return false;
      if (source && !this._sourceMatch(r.source, source)) return false;
      return true;
    });
    // 形态过滤：群聊滤 sensitive
    if (chatType === "group") rows = rows.filter((r) => !r.sensitive);

    // 向量准备（居中）
    const mu = this._centroid(all);
    let qVec = null, qc = null;
    if (keyword) qVec = await this.embed(keyword, "query");
    if (qVec) qc = mu ? MemoryStore.centeredUnit(qVec, mu) : qVec;

    // 语义相似度（全体条目，用于 CSLS 的 r_q）
    const sims = new Map();
    const items = [];
    if (qc) {
      for (const r of all) {
        const b = MemoryStore._vecBufToFloat(r.embedding);
        if (!b || MemoryStore.isZeroVec(b)) continue;
        const cv = mu ? MemoryStore.centeredUnit(b, mu) : b;
        if (!cv) continue;
        items.push({ id: r.id, v: cv });
        sims.set(r.id, MemoryStore.cosine(qc, cv));
      }
    }
    // CSLS：r_q = 查询对最近 k 条的平均相似度；r_x = 该条对最近 k 条的平均相似度
    const hub = this._hubScores(items);
    let rq = 0;
    if (hub && items.length) {
      const top = items.map((it) => sims.get(it.id)).sort((a, b) => b - a).slice(0, Math.min(this.cslsK, items.length));
      rq = top.length ? top.reduce((a, b) => a + b, 0) / top.length : 0;
    }

    // 候选打分
    const k = keyword ? MemoryStore._norm(keyword) : null;
    const cands = [];
    for (const r of rows) {
      const cos = sims.has(r.id) ? sims.get(r.id) : null;
      const score0 = cos != null && hub ? 2 * cos - rq - (hub.get(r.id) ?? 0) : cos;
      const hit = k ? MemoryStore._lexHit(k, r.content, r.tags) : false;
      cands.push({ r, cos, sim: score0, hit });
    }
    // 绝对门槛：没有语义命中的条目直接剔除（不靠字面命中绕过，避免往上下文灌噪音）
    const allSim = cands.filter((c) => c.cos != null).map((c) => c.sim);
    const maxSim = allSim.length ? Math.max(...allSim) : 0;
    const relFloor = maxSim > 0 ? this.gateRel * maxSim : -Infinity;
    const gated = cands.filter((c) => {
      if (c.cos == null) return false;            // 无向量：无法参与语义召回
      // 绝对门槛只在「居中空间」成立（门槛是按居中余弦分布标定的）；
      // 库太小/未开启居中时空间刻度不同，只能靠相对门槛。
      if (mu && c.sim < this.gateSim) return false;
      if (cands.length >= 20 && c.sim < relFloor) return false; // 相对门槛（候选多时收敛）
      return true;
    });
    if (!gated.length) return [];

    // min-max 归一化（GAM）
    const mm = (arr) => {
      let mn = Infinity, mx = -Infinity;
      for (const v of arr) { if (v < mn) mn = v; if (v > mx) mx = v; }
      const d = mx - mn;
      return arr.map((v) => (d > 1e-9 ? (v - mn) / d : 1));
    };
    const rel01 = mm(gated.map((c) => c.sim));
    const rec01 = gated.map((c) => Math.pow(this.recencyDecay, (Date.now() - Math.max(c.r.lastUsed || 0, c.r.ts)) / 3600000));
    const imp01 = gated.map((c) => Math.max(0, Math.min(10, c.r.importance ?? 5)) / 10);
    const w = this.weights;
    const scored = gated.map((c, i) => {
      const score =
        w.relevance * rel01[i] +
        w.importance * imp01[i] +
        w.recency * rec01[i] +
        w.keyword * (c.hit ? 1 : 0) +
        w.pinned * (c.r.pinned ? 1 : 0);
      return { ...c.r, score, cos: c.cos, sim: c.sim, relevance: rel01[i], recency: rec01[i], kwHit: c.hit };
    });
    scored.sort((a, b) => b.score - a.score);
    const out = scored.slice(0, Math.min(limit, 30));
    if (markUsed && out.length) this.markUsed(out.map((r) => r.id));
    return out;
  }

  /** 标记「被使用」：刷新 lastUsed 并累加 useCount（真实使用信号来自收割回复的 used_ids） */
  markUsed(ids) {
    const upd = this.db.prepare("UPDATE facts SET lastUsed = ?, useCount = useCount + 1 WHERE id = ?");
    const now = Date.now();
    let n = 0;
    for (const id of ids) {
      try { n += upd.run(now, id).changes; } catch { /* 忽略单条失败 */ }
    }
    return n;
  }

  _sourceMatch(rSource, filter) {
    if (filter.endsWith(":")) return rSource.startsWith(filter);
    if (filter === "seed") return rSource === "seed";
    return rSource === filter || rSource.startsWith(filter + ":");
  }

  /**
   * 渲染注入文本（prompt 前调用）
   * 分层：全局常驻（Letta core memory）→ 检索命中。
   * @returns {{text:string, hits:number, ids:string[]}}
   */
  async injectText({ query, chatType = "private", userId, targetId, includeGlobals = true }) {
    const parts = [];
    let hits = 0;
    let ids = [];
    let budget = this.injectChars;
    // 全局常驻（仅在 includeGlobals=true 时注入；会话内只注入一次，避免历史重复）
    if (includeGlobals) {
      const globals = this.db.prepare("SELECT content FROM global_facts WHERE enabled = 1").all();
      if (globals.length) {
        const gText = "【全局】\n" + globals.map((g) => "- " + g.content).join("\n");
        parts.push(gText);
        budget -= gText.length;
      }
    }
    // facts 检索（仅在有 query 时注入；无 query 跳过可省资源）
    // 来源隔离：群聊看该群共享记忆（group:<群id>），私聊看该用户个人记忆（private:<userId>），防止跨会话越权
    if (query && (userId || targetId) && budget > 200) {
      const source = memorySourceOf({ chatType, userId, targetId });
      const rows = await this.search({ keyword: query, chatType, source, limit: 20 });
      if (rows.length) {
        const lines = rows.map((r) => {
          const t = formatAgo(r.ts);
          const tag = r.type === "reflection" ? "洞见" : r.type;
          return `- [${tag} · ${t}] ${r.content}`;
        });
        let fText = "【记忆】\n" + lines.join("\n");
        if (fText.length > budget) fText = fText.slice(0, budget) + "…";
        parts.push(fText);
        hits = rows.length;
        ids = rows.map((r) => r.id);
      }
    }
    const text = parts.join("\n\n");
    return { text, hits, ids };
  }

  // ─────────────────────────── 管理（CLI 用）───────────────────────────
  stats() {
    const total = this.db.prepare("SELECT COUNT(*) c FROM facts").get().c;
    const byType = this.db.prepare("SELECT type, COUNT(*) c FROM facts GROUP BY type").all();
    const pinned = this.db.prepare("SELECT COUNT(*) c FROM facts WHERE pinned = 1").get().c;
    const sensitive = this.db.prepare("SELECT COUNT(*) c FROM facts WHERE sensitive = 1").get().c;
    const embOk = this.db.prepare("SELECT COUNT(*) c FROM facts WHERE length(embedding) > 0 AND embedding <> zeroblob(length(embedding))").get().c;
    const harvest = this.db.prepare("SELECT COUNT(*) c, MAX(ts) t FROM harvest_log").get();
    const globals = this.db.prepare("SELECT COUNT(*) c FROM global_facts WHERE enabled = 1").get().c;
    const invalid = this.db.prepare("SELECT COUNT(*) c FROM facts WHERE valid_until IS NOT NULL").get().c;
    const avgImp = this.db.prepare("SELECT AVG(importance) a FROM facts").get().a;
    const used = this.db.prepare("SELECT SUM(useCount) s FROM facts").get().s;
    return {
      total, byType, pinned, sensitive, embOk, globals, invalid,
      avgImportance: avgImp ? +Number(avgImp).toFixed(2) : null,
      usedTotal: Number(used ?? 0),
      history: this.db.prepare("SELECT COUNT(*) c FROM fact_history").get().c,
      harvest: { count: harvest.c, lastTs: harvest.t ?? 0 },
    };
  }

  list({ type, search, limit = 50 }) {
    let sql = "SELECT * FROM facts WHERE 1=1";
    const params = [];
    if (type) { sql += " AND type = ?"; params.push(type); }
    if (search) { sql += " AND (content LIKE ? OR tags LIKE ?)"; params.push(`%${search}%`, `%${search}%`); }
    sql += " ORDER BY ts DESC LIMIT ?";
    params.push(limit);
    return this.db.prepare(sql).all(...params);
  }

  deleteById(id, source) {
    if (source) {
      const row = this.db.prepare("SELECT source FROM facts WHERE id = ?").get(id);
      if (!row) return 0;       // 不存在
      if (row.source !== source) return -1; // 非本人/本群来源，无权删除
    }
    const n = this.db.prepare("DELETE FROM facts WHERE id = ?").run(id).changes;
    if (n) this._markGeomDirty();
    return n;
  }

  deleteBySearch(search) {
    const rows = this.db.prepare("SELECT id FROM facts WHERE content LIKE ? OR tags LIKE ?").all(`%${search}%`, `%${search}%`);
    const del = this.db.prepare("DELETE FROM facts WHERE id = ?");
    let n = 0;
    for (const r of rows) n += del.run(r.id).changes;
    if (n) this._markGeomDirty();
    return n;
  }

  clear(keepPinned = true) {
    const r = keepPinned
      ? this.db.prepare("DELETE FROM facts WHERE pinned = 0").run()
      : this.db.prepare("DELETE FROM facts").run();
    this._markGeomDirty();
    return r.changes;
  }

  /** 清除脏数据：无向量（embedding 为 NULL/空）的孤儿 fact 及其它表的孤儿记录
   * 保留有效记忆（有向量、pinned、global_facts）。
   * @returns {{facts:number, harvest:number, user_perms:number}} */
  purgeDirty() {
    const facts = this.db
      .prepare("DELETE FROM facts WHERE embedding IS NULL OR length(embedding) = 0")
      .run().changes;
    // 收割日志中指向已清空会话的残留（可选，保底清理空会话项）
    const harvest = this.db
      .prepare("DELETE FROM harvest_log WHERE (session IS NULL OR session = '')")
      .run().changes;
    if (facts) this._markGeomDirty();
    // 权限表无变化（不自动清 user_perms，避免误删授权）
    return { facts, harvest, user_perms: 0 };
  }

  harvestLog({ lastHours = 24 } = {}) {
    const since = Date.now() - lastHours * 3600000;
    return this.db.prepare("SELECT * FROM harvest_log WHERE ts >= ? ORDER BY ts DESC LIMIT 50").all(since);
  }

  close() {
    if (this._embedder?.dispose) try { this._embedder.dispose(); } catch {}
    this.db?.close();
  }
}

function formatAgo(ts) {
  const diff = Date.now() - ts;
  const m = Math.floor(diff / 60000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}分钟前`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}小时前`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}天前`;
  return new Date(ts).toISOString().slice(0, 10);
}

export function createMemoryStore(opts) {
  return new MemoryStore(opts).init();
}
