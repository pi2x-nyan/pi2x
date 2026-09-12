/**
 * 轻量 CDP 浏览器客户端（node 全局 WebSocket + headless Chrome/Edge remote debugging）。
 *
 * —— 防"卡住"保护 ——
 *  1) send()：每个 CDP 调用带超时（默认 30s），到期 reject，绝不永久挂起；
 *  2) _ensure()：/json/list 抓取与 WS 连接都有超时；
 *  3) navigate()：**不再等 load 事件**（流式/SSE/长连接页面永不触发 load 会卡死），
 *     改为轮询 location.href + readyState，带超时返回；
 *  4) eval()/screenshot() 均经由带超时的 send()。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 项目根：由本文件位置推导，避免写死部署路径 */
const ROOT_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

const DEFAULT_PORT = 9222;
const DEFAULT_SEND_TIMEOUT = 30000;

export class CdpBrowser {
  constructor({ port = DEFAULT_PORT, sendTimeoutMs = DEFAULT_SEND_TIMEOUT } = {}) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
    this.sendTimeoutMs = sendTimeoutMs;
    this.ws = null;
    this._seq = 0;
    this._pending = new Map();
  }

  /** Chrome（headless）是否已在端口上运行 */
  static async isRunning(port = DEFAULT_PORT) {
    try {
      const r = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(1500) });
      return r.ok;
    } catch {
      return false;
    }
  }

  /** 找到（或创建）一个 page target 并连接 */
  async _ensure() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) return;
    let list;
    try {
      list = await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(5000) }).then((r) => r.json());
    } catch (e) {
      throw new Error(`CDP 列表获取失败: ${e?.cause?.code ?? e?.message ?? e}`);
    }
    let page = Array.isArray(list) ? list.find((t) => t.type === "page") : null;
    if (!page) {
      // 无 page：打开新标签（http PUT /json/new）
      try {
        page = await fetch(`${this.base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(5000) }).then((x) => x.json());
      } catch (e) {
        throw new Error(`CDP 开新标签失败: ${e?.cause?.code ?? e?.message ?? e}`);
      }
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      const to = setTimeout(() => rej(new Error("CDP WebSocket 连接超时(8s)")), 8000);
      this.ws.onopen = () => { clearTimeout(to); res(); };
      this.ws.onerror = (e) => { clearTimeout(to); rej(new Error("CDP 连接失败: " + (e?.message ?? ""))); };
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const p = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        if (p.timer) clearTimeout(p.timer);
        msg.error ? p.reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`)) : p.resolve(msg.result);
      }
    };
    this.ws.onclose = () => { this.ws = null; };
  }

  /**
   * 发送 CDP 命令，带超时（默认 sendTimeoutMs）。
   * 超时后 reject 并从 pending 清除，防止调用永久挂起。
   */
  send(method, params = {}, timeoutMs = this.sendTimeoutMs) {
    return new Promise(async (resolve, reject) => {
      try { await this._ensure(); } catch (e) { return reject(e); }
      const id = ++this._seq;
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP 超时(${timeoutMs}ms): ${method}`));
      }, timeoutMs) : null;
      this._pending.set(id, {
        resolve: (v) => { if (timer) clearTimeout(timer); resolve(v); },
        reject: (e) => { if (timer) clearTimeout(timer); reject(e); },
      });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { if (timer) clearTimeout(timer); this._pending.delete(id); reject(e); }
    });
  }

  /** 等页面 readyState 就绪（轮询 + 超时，不等 load 事件） */
  async _waitLoad(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const s = await this.eval("document.readyState", 5000);
        if (s === "complete" || s === "interactive") return;
      } catch { /* 页面可能还在导航 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** 执行 JS，返回 value（JSON 可序列化）；超时经 send() */
  async eval(expression, timeoutMs = this.sendTimeoutMs) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "JS 异常";
      throw new Error(d.slice(0, 300));
    }
    return r.result?.value;
  }

  /**
   * 导航：立即发起 Page.navigate，然后**轮询** URL + readyState（带超时）。
   * 不等 load 事件 —— 对 SSE / streaming SSR / 长连接页面（如 commandcode.ai/studio）
   * 永不触发 load 的情况免疫卡死。返回 { url, readyState, timedOut }。
   */
  async navigate(url, { timeoutMs = 25000 } = {}) {
    const target = String(url);
    try { await this.send("Page.navigate", { url: target }, 15000); } catch (e) { /* 忽略导航超时，继续轮询 */ }
    const t0 = Date.now();
    let last = { url: target, readyState: "pending" };
    while (Date.now() - t0 < timeoutMs) {
      try {
        const info = await this.eval(`JSON.stringify({ u: location.href, r: document.readyState, t: document.title })`, 5000);
        if (info) last = JSON.parse(info);
        const moved = last.u && last.u !== "about:blank" && last.u !== target;
        if (last.r === "complete" || last.r === "interactive" || (moved && last.r !== "loading")) {
          return { url: last.u, title: last.t, readyState: last.r, timedOut: false };
        }
      } catch { /* 导航中 */ }
      await new Promise((r) => setTimeout(r, 400));
    }
    return { url: last.u || target, title: last.t, readyState: "timeout", timedOut: true };
  }

  /** 页面正文文本（排除 script/style） */
  async readText() {
    return this.eval(`(() => {
      const c = document.body ? document.body.innerText : "";
      return { url: location.href, title: document.title, text: c.slice(0, 6000) };
    })()`);
  }

  /** React 兼容的输入设置（原生 setter + input 事件） */
  async type(selector, text) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "ERR:未找到 ${selector}";
      el.focus();
      const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")?.set ||
                     Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, "value")?.set;
      if (setter) setter.call(el, ${JSON.stringify(text)});
      else el.value = ${JSON.stringify(text)};
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return "OK";
    })()`);
  }

  async click(selector) {
    return this.eval(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return "ERR:未找到 ${selector}";
      el.click();
      return "OK";
    })()`);
  }

  /** 截图存盘；path 为空自动生成到 tmp */
  async screenshot(outPath = null) {
    const r = await this.send("Page.captureScreenshot", { format: "png" }, 20000);
    const b64 = r?.data;
    if (!b64) throw new Error("截图无数据");
    const fs = await import("node:fs");
    const path = await import("node:path");
    if (!outPath) {
      // 默认落点按环境选择：
      //   · 沙盒用户（operator 等）→ 自己的沙盒目录（沙箱里 <PI2X_ROOT>/tmp 不可见，
      //     写不进去会直接失败；PI2X_SANDBOX_DIR 由 sandbox bash 注入）
      //   · 管理员 → <PI2X_ROOT>/tmp（原来的默认值，保持不变）
      const sbx = process.env.PI2X_SANDBOX_DIR;
      const dir = sbx ? path.join(sbx, "screenshots") : process.env.PI2X_SCREENSHOT_DIR || path.join(ROOT_DIR, "tmp");
      try { fs.mkdirSync(dir, { recursive: true }); } catch {}
      outPath = path.join(dir, `shot-${Date.now()}.png`);
    }
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    return outPath;
  }

  /** 关闭当前激活的 page 标签页（任务完成后清理）；全部关完则新开一个 blank 保持浏览器可用 */
  async closePage() {
    let pages = [];
    try { pages = (await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json())).filter((t) => t.type === "page"); } catch {}
    if (!pages.length) return "（无标签页）";
    const target = pages[pages.length - 1];
    await fetch(`${this.base}/json/close/${target.id}`, { method: "PUT", signal: AbortSignal.timeout(4000) }).catch(() => {});
    try {
      const remain = (await fetch(`${this.base}/json/list`, { signal: AbortSignal.timeout(4000) }).then((r) => r.json())).filter((t) => t.type === "page");
      if (!remain.length) await fetch(`${this.base}/json/new?about:blank`, { method: "PUT", signal: AbortSignal.timeout(4000) }).catch(() => {});
    } catch {}
    return `已关闭标签页 ${target.id}`;
  }

  /** 关闭连接 */
  close() {
    try { this.ws?.close(); } catch {}
    this.ws = null;
  }
}

/** 全局单例（按端口缓存，供工具并行时复用浏览器与登录态；不同端口=不同用户隔离实例） */
const _insts = new Map();
export function getBrowser(port = DEFAULT_PORT) {
  if (!_insts.has(port)) _insts.set(port, new CdpBrowser({ port }));
  return _insts.get(port);
}