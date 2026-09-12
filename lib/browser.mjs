/**
 * 轻量 CDP 浏览器客户端（node 全局 WebSocket + headless Chrome/Edge remote debugging）。
 * 供 PI2X 的 browser_* 工具使用：单实例连接常驻 Chrome（保留登录态）。
 */
const DEFAULT_PORT = 9222;

// 自身位置推导项目根：截图默认落 <ROOT>/tmp（不再写死部署路径）
import path from "node:path";
import { fileURLToPath } from "node:url";
const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

export class CdpBrowser {
  constructor({ port = DEFAULT_PORT } = {}) {
    this.port = port;
    this.base = `http://127.0.0.1:${port}`;
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
    const list = await fetch(`${this.base}/json/list`).then((r) => r.json());
    let page = Array.isArray(list) ? list.find((t) => t.type === "page") : null;
    if (!page) {
      // 无 page：打开新标签（http PUT /json/new）
      const r = await fetch(`${this.base}/json/new?about:blank`, { method: "PUT" }).then((x) => x.json());
      page = r;
    }
    this.ws = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = (e) => rej(new Error("CDP 连接失败: " + (e?.message ?? "")));
    });
    this.ws.onmessage = (ev) => {
      let msg;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (msg.id && this._pending.has(msg.id)) {
        const { resolve, reject } = this._pending.get(msg.id);
        this._pending.delete(msg.id);
        msg.error ? reject(new Error(`CDP ${msg.error.code}: ${msg.error.message}`)) : resolve(msg.result);
      }
    };
    this.ws.onclose = () => { this.ws = null; };
  }

  send(method, params = {}) {
    return new Promise(async (resolve, reject) => {
      try { await this._ensure(); } catch (e) { return reject(e); }
      const id = ++this._seq;
      this._pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); }
      catch (e) { this._pending.delete(id); reject(e); }
    });
  }

  /** 等页面 load（轮询 readyState） */
  async _waitLoad(timeoutMs = 20000) {
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try {
        const s = await this.eval("document.readyState");
        if (s === "complete" || s === "interactive") return;
      } catch { /* 页面可能还在导航 */ }
      await new Promise((r) => setTimeout(r, 300));
    }
  }

  /** 执行 JS，返回 value（JSON 可序列化） */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description || r.exceptionDetails.text || "JS 异常";
      throw new Error(d.slice(0, 300));
    }
    return r.result?.value;
  }

  async navigate(url) {
    await this.send("Page.navigate", { url: String(url) });
    await this._waitLoad();
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
    const r = await this.send("Page.captureScreenshot", { format: "png" });
    const b64 = r?.data;
    if (!b64) throw new Error("截图无数据");
    const { mkdirSync } = await import("node:fs");
    const path = await import("node:path");
    if (!outPath) {
      const dir = path.join(ROOT, "tmp");
      mkdirSync(dir, { recursive: true });
      outPath = path.join(dir, `shot-${Date.now()}.png`);
    }
    const fs = await import("node:fs");
    fs.writeFileSync(outPath, Buffer.from(b64, "base64"));
    return outPath;
  }

  /** 关闭当前激活的 page 标签页（任务完成后清理）；全部关完则新开一个 blank 保持浏览器可用 */
  async closePage() {
    const list = await fetch(`${this.base}/json/list`).then((r) => r.json());
    const pages = Array.isArray(list) ? list.filter((t) => t.type === "page") : [];
    if (!pages.length) return "（无标签页）";
    // 关掉第一个 page（当前激活）
    const target = pages[pages.length - 1];
    await fetch(`${this.base}/json/close/${target.id}`, { method: "PUT" }).catch(() => {});
    // 若全部关闭，重开 blank（浏览器常驻可用）
    const remain = (await fetch(`${this.base}/json/list`).then((r) => r.json())).filter((t) => t.type === "page");
    if (!remain.length) await fetch(`${this.base}/json/new?about:blank`, { method: "PUT" }).catch(() => {});
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