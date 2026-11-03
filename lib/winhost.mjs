/**
 * win-agent 寻址 —— 优先 EasyTier 组网 IP（winShell.host），不通自动回退备用地址
 * （winShell.fallbackHost / fallbackHosts，通常是 LAN IP）。
 *
 * 关键设计（都是踩过的坑）：
 *  1. **探测缓存 + TTL**：首选地址悄悄挂掉时不能一直用它；超过 TTL 重新探测。
 *  2. **双探测快速失败**：两个地址都挂时，不能让每次调用各白等一个完整超时；
 *     先用短探测（probeTimeoutMs）确认，连挂两次就立刻抛错。
 *  3. **每次尝试独立超时信号**：caller 传进来的 AbortSignal 一旦超时就被永久中止，
 *     复用到下一跳会让备用地址直接被掐掉（现象是「两个地址都超时」）。
 */
import path from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { config, DEFAULTS } from "./config.mjs";
import { createLogger } from "./log.mjs";

const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 默认的发现实现：跑 scripts/find-win-host.mjs，从它的 FOUND=<ip> 行取结果。
 * 背景：手机与 Windows 都在校园网 DHCP 下，地址会变；两者不在同一 L2（ARP 里全是 VRRP 网关
 * 虚拟 MAC），所以只能靠扫描。脚本内部先试当前值/缓存/同网段，最后才扫整个 /18（约 30~60s）。
 */
function spawnDiscover({ token, port, timeoutMs, logger }) {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [path.join(ROOT_DIR, "scripts", "find-win-host.mjs"), "--quiet"],
      { timeout: timeoutMs, cwd: ROOT_DIR, env: { ...process.env } },
      (err, stdout) => {
        if (err && !stdout) { logger?.warn?.("[winShell] 自动发现失败: " + err.message); return resolve(null); }
        const m = String(stdout).match(/FOUND=(\d+\.\d+\.\d+\.\d+)/);
        if (m) { logger?.log?.("[winShell] 自动发现到 win-agent: " + m[1] + ":" + port); return resolve(m[1]); }
        resolve(null);
      },
    );
  });
}

/**
 * 默认 logger。
 * 原默认值是全局 `console`（直写 stdout），导致 `[winShell] 选用/使用 x.x.x.x:8123`
 * 这类行没有时间戳。改用 createLogger 后自动带日期与 scope。
 */
const logWin = createLogger("winShell");

export class WinHostResolver {
  /**
   * @param {object} wsCfg winShell 配置
   * @param {{fetchImpl?: typeof fetch, logger?: Console}} [opts]
   */
  constructor(wsCfg = {}, { fetchImpl = fetch, logger = logWin, now = Date.now, discoverImpl = spawnDiscover } = {}) {
    this.ws = wsCfg ?? {};
    this.fetchImpl = fetchImpl;
    this.logger = logger;
    this.now = now;
    // 本类允许被注入任意 wsCfg（测试/多实例），所以这里回落到 DEFAULTS 而非再写一个字面量——
    // 默认值仍然只有一处（lib/config.mjs），不会出现两处数值漂移。
    this.ttl = Number(this.ws.probeTtlMs ?? DEFAULTS.winShell.probeTtlMs);
    this.current = null;
    this.currentTs = 0;
    // 自动发现（显式开关）：只有配置里 autoDiscover === true 才启用。
    // 刻意「显式」而不用 DEFAULTS 兜底 —— 否则单测里所有候选都不通时会去真扫网，测试会变慢且不稳定。
    this.autoDiscover = this.ws.autoDiscover === true;
    this.discoverTimeoutMs = Number(this.ws.discoverTimeoutMs ?? DEFAULTS.winShell.discoverTimeoutMs);
    this.discoverImpl = discoverImpl;
    this.discovered = []; // 发现到的地址（并入候选）
  }

  /** 候选地址（去重、去空） */
  get candidates() {
    const ws = this.ws ?? {};
    const raw = [
      ws.host,
      ws.fallbackHost,
      ...(Array.isArray(ws.fallbackHosts) ? ws.fallbackHosts : []),
      ...(this.discovered ?? []),
    ];
    return [...new Set(raw.filter(Boolean))];
  }

  get port() {
    return this.ws?.port;
  }

  /** 当前实际使用的 win-agent 主机（未探测时为首选地址） */
  active() {
    return this.current ?? this.ws?.host ?? null;
  }

  /** 缓存是否仍然可信 */
  _fresh() {
    return !!this.current && this.candidates.includes(this.current) && this.now() - this.currentTs < this.ttl;
  }

  invalidate() {
    this.current = null;
    this.currentTs = 0;
  }

  _url(host, pathname) {
    return `http://${host}:${this.port}${pathname}`;
  }

  /** 取一个可达的 win-agent 主机；全部不通时返回 null */
  async pick() {
    const cands = this.candidates;
    if (!cands.length) throw new Error("winShell 未配置 host");
    if (this._fresh()) return this.current;
    for (const h of cands) {
      try {
        const r = await this.fetchImpl(this._url(h, "/ping"), {
          headers: { Authorization: `Bearer ${this.ws.token}` },
          signal: AbortSignal.timeout(Number(this.ws.probeTimeoutMs ?? DEFAULTS.winShell.probeTimeoutMs)),
        });
        if (r.ok) {
          if (this.current !== h) this.logger.log?.(`[winShell] 选用 ${h}:${this.port}`);
          this.current = h;
          this.currentTs = this.now();
          return h;
        }
      } catch {
        /* 探测失败：试下一个 */
      }
    }
    // 全部候选都不可达 → 自动发现一次（若启用），拿到新地址后重试一轮
    if (this.autoDiscover) {
      const found = await this.discoverImpl({
        token: this.ws.token,
        port: this.port,
        timeoutMs: this.discoverTimeoutMs,
        logger: this.logger,
      });
      if (found && !this.candidates.includes(found)) {
        this.discovered.push(found);
        this.invalidate();
        return this.pick();
      }
    }
    return null;
  }

  /** 带自动回退的 win-agent 请求：首选主机连不上就换备用地址重试 */
  async fetch(pathname, init = {}) {
    const cands = this.candidates;
    if (!cands.length) throw new Error("winShell 未配置 host");

    // 先用短探测确定可达主机并缓存；否则首选地址若是「挂起」而非「拒绝」，
    // 每次调用都要先白等一个完整超时。
    let reachable = this._fresh();
    if (!reachable) {
      try {
        reachable = !!(await this.pick());
      } catch {
        /* ignore */
      }
      // 短探测可能因网络抖动误判 → 复测一次；仍全挂则快速失败
      if (!reachable) {
        try {
          reachable = !!(await this.pick());
        } catch {
          /* ignore */
        }
      }
      if (!reachable) throw new Error(`winShell 不可达（${cands.join(" / ")}:${this.port} 均无响应）`);
    }

    const order = this.current && cands.includes(this.current)
      ? [this.current, ...cands.filter((h) => h !== this.current)]
      : cands;

    const { timeoutMs, signal, ...rest } = init;
    let lastErr;
    for (let i = 0; i < order.length; i++) {
      const h = order[i];
      const o = { ...rest };
      // 每次尝试用「独立」的超时信号（见文件头注释第 3 条）
      const fresh = timeoutMs ? AbortSignal.timeout(timeoutMs) : i > 0 ? AbortSignal.timeout(30000) : null;
      if (fresh && signal) o.signal = AbortSignal.any([signal, fresh]);
      else if (fresh) o.signal = fresh;
      else if (signal) o.signal = signal;
      try {
        const r = await this.fetchImpl(this._url(h, pathname), o);
        if (this.current !== h) this.logger.log?.(`[winShell] 使用 ${h}:${this.port}`);
        this.current = h;
        this.currentTs = this.now();
        return r;
      } catch (e) {
        lastErr = e;
        if (this.current === h) this.invalidate();
        if (signal?.aborted) throw e; // 外部主动中止：不再尝试其它地址
      }
    }
    throw lastErr ?? new Error("winShell 不可达");
  }

  /** JSON 便捷方法 */
  async json(pathname, init = {}) {
    const r = await this.fetch(pathname, init);
    if (!r.ok) throw new Error(`win-agent ${pathname} HTTP ${r.status}`);
    return await r.json();
  }
}

/** 绑定到当前配置的全局实例 */
export const winHost = new WinHostResolver(config.winShell);

/** 当前实际使用的 win-agent 主机（保持旧导出名，向后兼容） */
export function winActiveHost() {
  return winHost.active();
}

export default winHost;
