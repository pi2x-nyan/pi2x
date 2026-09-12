/**
 * PI2X Win-Agent — Windows 远程 shell 服务（供 Linux 上的 PI2X bot 调用）
 *
 * 功能：
 *  - POST /exec         {command}           → 在 Windows 上执行命令（powershell）
 *  - GET  /health       → 健康检查
 * 鉴权：Header  Authorization: Bearer <token>
 *
 * 启动：node win-agent/service.mjs   （静默后台：start /b 或 PM2/计划任务）
 */
import http from "node:http";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = path.join(__dirname, "config.json");

// ---------- 配置 ----------
let config = { port: 8123, token: "", host: "0.0.0.0" };
if (fs.existsSync(CONFIG_FILE)) {
  try { config = { ...config, ...JSON.parse(fs.readFileSync(CONFIG_FILE, "utf8")) }; } catch {}
}
if (!config.token) {
  config.token = crypto.randomBytes(24).toString("hex");
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2));
  console.log(`[win-agent] 已生成新 token: ${config.token}`);
}
const PORT = config.port;
const TOKEN = config.token;
const MAX_BYTES = 60 * 1024; // 输出上限

function auth(req) {
  const h = req.headers.authorization ?? "";
  return h === `Bearer ${TOKEN}`;
}

/** ⇊ 常驻 pi RPC 子进程（subagent 后端） — pi --mode rpc JSONL 协议 */
class PiRpc {
  constructor() {
    this.child = null;
    this.buf = "";
    this.errBuf = "";
    this.ready = false;
    this.readyWaiters = [];
    this.job = null; // { id, delta, resolve, timer }
    this._seq = 0;
  }

  start() {
    if (this.child) return;
    this.child = spawn("cmd.exe", ["/c", "pi --mode rpc"], {
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
    this.child.stdout.on("data", (d) => this._onData(d.toString("utf8")));
    this.child.stderr.on("data", (d) => {
      this.errBuf = (this.errBuf + d.toString("utf8")).slice(-8000);
    });
    this.child.on("exit", () => {
      console.log("[pi-rpc] 进程退出，准备重启");
      this.child = null;
      this.ready = false;
      if (this.job) {
        const j = this.job;
        this.job = null;
        j.resolve({ error: "pi-rpc 进程退出: " + this.errBuf.slice(-300), text: "" });
      }
      setTimeout(() => this.start(), 3000);
    });
  }

  _onData(s) {
    this.buf += s;
    let idx;
    while ((idx = this.buf.indexOf("\n")) >= 0) {
      const line = this.buf.slice(0, idx).replace(/\r$/, "");
      this.buf = this.buf.slice(idx + 1);
      if (!line.trim()) continue;
      let rec;
      try { rec = JSON.parse(line); } catch { continue; }
      this._handle(rec);
    }
  }

  _handle(rec) {
    if (rec.type === "response" && this.job && rec.id === this.job.id) {
      if (rec.success !== true) {
        const j = this.job;
        this.job = null;
        clearTimeout(j.timer);
        j.resolve({ error: rec.error || "prompt 被拒绝", text: j.delta });
      }
      // success=true 表示已接受，继续等待流式事件
    } else if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") {
      if (this.job) this.job.delta += rec.assistantMessageEvent.delta ?? "";
    } else if (rec.type === "agent_settled" || rec.type === "agent_end") {
      if (this.job) {
        const j = this.job;
        this.job = null;
        clearTimeout(j.timer);
        j.resolve({ text: j.delta });
      }
    }
  }

  /** 显式中止当前 pi RPC 任务（/stop 触发） */
  abort() {
    const j = this.job;
    if (j) {
      this.job = null;
      clearTimeout(j.timer);
      j.resolve({ error: "已由用户中止（/stop）", text: j.delta });
    }
    try {
      if (this.child) this.child.stdin.write(JSON.stringify({ type: "abort" }) + "\n", "utf8");
    } catch {}
  }

  async prompt(message, timeoutMs) {
    if (!this.child) this.start();
    if (this.job) return { error: "pi-rpc 忙（上次任务未完成），请稍后重试", text: "" };
    // 等待子进程就绪（首次 spawn 需一点时间建立管道）
    await new Promise((r) => setTimeout(r, 1200));
    const id = "r" + (++this._seq);
    const job = { id, delta: "", resolve: null, timer: null };
    this.job = job;
    return await new Promise((resolve) => {
      job.resolve = resolve;
      job.timer = setTimeout(() => {
        if (this.job === job) {
          this.job = null;
          resolve({ error: "超时(" + Math.round(timeoutMs / 1000) + "s)", text: job.delta });
        }
      }, timeoutMs);
      try {
        this.child.stdin.write(JSON.stringify({ id, type: "prompt", message }) + "\n", "utf8");
      } catch (e) {
        this.job = null;
        clearTimeout(job.timer);
        resolve({ error: "写入失败: " + e.message, text: "" });
      }
    });
  }
}
const piRpc = new PiRpc();
piRpc.start();
console.log("[pi-rpc] 已启动常驻 pi RPC 服务（Windows subagent）");

/** 执行 Windows 命令（默认 powershell；shell="cmd" 时用 cmd.exe /c，超时 90s）
 * cmd 模式：windowsVerbatimArguments 原样传递管道/引号（不做任何翻译） */
function runCommand(command, timeoutMs = 90000, shell = "powershell") {
  return new Promise((resolve) => {
    let args, bin, opts = { windowsHide: true };
    if (shell === "cmd") {
      bin = "cmd.exe";
      args = ["/c", String(command)];
      opts.windowsVerbatimArguments = true; // 原样传递管道/引号给 cmd 解析
    } else {
      bin = "powershell.exe";
      args = ["-NoProfile", "-NonInteractive", "-Command", command];
    }
    const child = spawn(bin, args, opts);
    let out = "", err = "";
    child.stdout.on("data", (d) => { if (out.length < MAX_BYTES) out += d.toString("utf8").slice(0, MAX_BYTES - out.length); });
    child.stderr.on("data", (d) => { if (err.length < MAX_BYTES) err += d.toString("utf8").slice(0, MAX_BYTES - err.length); });
    let timer = null;
    if (timeoutMs > 0) {
      timer = setTimeout(() => { child.kill(); resolve({ stdout: out, stderr: err + "\n(超时" + Math.round(timeoutMs / 1000) + "s 已终止)", exitCode: -1 }); }, timeoutMs);
    }
    child.on("close", (code) => { if (timer) clearTimeout(timer); resolve({ stdout: out, stderr: err, exitCode: code }); });
  });
}

/** 截取屏幕 → base64 PNG（已弃用：不再提供截图能力） */

const server = http.createServer(async (req, res) => {
  const send = (code, obj) => {
    res.writeHead(code, { "Content-Type": "application/json" });
    res.end(JSON.stringify(obj));
  };
  if (!auth(req)) return send(401, { error: "unauthorized" });

  try {
    const url = new URL(req.url, `http://${req.headers.host ?? "localhost"}`);

    if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/ping")) {
      return send(200, { ok: true, time: new Date().toISOString() });
    }

    if (req.method === "POST" && url.pathname === "/exec") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { command, shell, timeoutMs } = JSON.parse(body || "{}");
      if (!command || typeof command !== "string") return send(400, { error: "command 必填" });
      const tRaw = Number(timeoutMs ?? 90000);
      // timeoutMs <= 0 表示无限时（> 命令路由）；否则 5s~300s
      const cap = tRaw <= 0 ? 0 : Math.min(Math.max(tRaw, 5000), 300000);
      const r = await runCommand(command, cap, shell === "cmd" ? "cmd" : "powershell");
      return send(200, { ...r, shellUsed: shell === "cmd" ? "cmd" : "powershell" });
    }

    if (req.method === "POST" && url.pathname === "/pi/run") {
      // 调用 Windows 上配置好的 pi（常驻 RPC 子进程）作为 subagent
      let body = "";
      for await (const chunk of req) body += chunk;
      const { task, timeout } = JSON.parse(body || "{}");
      if (!task || typeof task !== "string") return send(400, { error: "task 必填" });
      const t0 = Date.now();
      const secs = Math.min(Math.max(Number(timeout ?? 240), 30), 600);
      const r = await piRpc.prompt(String(task), secs * 1000);
      return send(200, {
        stdout: r.text || "",
        stderr: r.error ? r.error : "",
        exitCode: r.error ? 1 : 0,
        ms: Date.now() - t0,
      });
    }

    if (req.method === "POST" && url.pathname === "/pi/abort") {
      piRpc.abort();
      return send(200, { ok: true });
    }

    // ── 文件传输：read = 从 Windows 读文件（返回 base64）；write = 写入 Windows 文件（收 base64）──

    // ── 文件传输：read = 从 Windows 读文件（返回 base64）；write = 写入 Windows 文件（收 base64）──
    if (req.method === "POST" && url.pathname === "/file/read") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const { remote } = JSON.parse(body || "{}");
      if (!remote || typeof remote !== "string") return send(400, { error: "remote 必填（Windows 文件路径）" });
      try {
        const stat = fs.statSync(remote);
        if (stat.isDirectory()) return send(400, { error: "是目录，请指定文件" });
        const MAX = 60 * 1024 * 1024;
        if (stat.size > MAX) return send(413, { error: `文件过大（${stat.size} > ${MAX}）` });
        const data = fs.readFileSync(remote).toString("base64");
        return send(200, { name: path.basename(remote), size: stat.size, data });
      } catch (e) {
        return send(404, { error: `读取失败: ${e?.message ?? e}` });
      }
    }

    if (req.method === "POST" && url.pathname === "/file/write") {
      let body = "";
      for await (const chunk of req) body += chunk;
      const payload = JSON.parse(body || "{}");
      const { remote, name } = payload;
      const data = payload.data;
      if (!remote || typeof remote !== "string" || typeof data !== "string") {
        return send(400, { error: "remote(data(base64) 必填" });
      }
      try {
        const finalPath = path.isAbsolute(remote) ? remote : path.join(process.cwd(), remote);
        fs.mkdirSync(path.dirname(finalPath), { recursive: true });
        fs.writeFileSync(finalPath, Buffer.from(data, "base64"));
        return send(200, { ok: true, path: finalPath, bytes: Buffer.byteLength(data, "base64") });
      } catch (e) {
        return send(500, { error: `写入失败: ${e?.message ?? e}` });
      }
    }

    return send(404, { error: "not found" });
  } catch (e) {
    return send(500, { error: String(e?.message ?? e) });
  }
});

server.listen(PORT, config.host, () => {
  console.log(`[win-agent] 服务已启动 http://${config.host}:${PORT}`);
  console.log(`[win-agent] token: ${TOKEN}`);
});