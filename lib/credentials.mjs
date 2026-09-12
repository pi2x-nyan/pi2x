/**
 * PI2X 凭据存储 —— AES-256-GCM 加密，Linux/Windows 跨机按需解密取用
 *
 * 安全原则：
 *  - 凭据绝不计入记忆库（facts），避免被记忆摘要/群聊暴露
 *  - password/token 用 AES-256-GCM 加密存储，密钥来自 PI2X_CRED_SECRET 环境变量或 config.credSecret
 *  - 只有 getCredential(domain) 主动解密，且仅 admin 会话可读
 *  - 明文只在拼装 auth 时短暂存在，不回显、不入日志
 *
 * 结构：credentials(domain PK, username, password_enc, token_enc, updated_at)
 *   username 明文存（非敏感）；password_enc/token_enc 密文（hex:iv:tag:data）
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const __dirname = path.dirname(new URL(import.meta.url).pathname);
const ROOT = path.resolve(__dirname, "..");

function resolveSecret() {
  const env = process.env.PI2X_CRED_SECRET;
  if (env && env.length >= 32) return env;
  const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
  if (typeof cfg.credSecret === "string" && cfg.credSecret.length >= 32) return cfg.credSecret;
  throw new Error("未配置凭据加密密钥：请设置环境变量 PI2X_CRED_SECRET（≥32字符）或 config.json 的 credSecret");
}

export class CredentialStore {
  constructor({ dbPath } = {}) {
    this.dbPath = dbPath ?? path.join(ROOT, "workspace", "memories", "credentials.db");
    fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
    this.secret = Buffer.from(resolveSecret(), "utf8");
    this.key = crypto.createHash("sha256").update(this.secret).digest(); // 32B key for aes-256-gcm
    this.db = new DatabaseSync(this.dbPath);
    this.db.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credentials (
        domain       TEXT PRIMARY KEY,
        username     TEXT NOT NULL DEFAULT '',
        password_enc TEXT NOT NULL DEFAULT '',
        token_enc    TEXT NOT NULL DEFAULT '',
        updated_at   INTEGER NOT NULL
      )
    `);
  }

  /** 加密一段明文 → hex(iv:tag:data) */
  _enc(plain) {
    if (!plain) return "";
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("aes-256-gcm", this.key, iv);
    const enc = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
    const tag = cipher.getAuthTag();
    return [iv.toString("hex"), tag.toString("hex"), enc.toString("hex")].join(":");
  }

  /** 解密 hex(iv:tag:data) → 明文；空/损坏返回 '' */
  _dec(str) {
    if (!str) return "";
    try {
      const [ivH, tagH, dataH] = str.split(":");
      if (!ivH || !tagH || !dataH) return "";
      const decipher = crypto.createDecipheriv("aes-256-gcm", this.key, Buffer.from(ivH, "hex"));
      decipher.setAuthTag(Buffer.from(tagH, "hex"));
      const dec = Buffer.concat([decipher.update(Buffer.from(dataH, "hex")), decipher.final()]);
      return dec.toString("utf8");
    } catch {
      return "";
    }
  }

  /**
   * 录入/更新一个凭据（密码/token 加密存储；username 明文）。
   * @param {{domain:string, username?:string, password?:string, token?:string}} c
   * @returns {{ok:boolean, text:string}}
   */
  set({ domain, username = "", password = "", token = "" }) {
    if (!domain) return { ok: false, text: "domain 必填" };
    this.db
      .prepare(`INSERT INTO credentials (domain, username, password_enc, token_enc, updated_at)
                VALUES (?, ?, ?, ?, ?)
                ON CONFLICT(domain) DO UPDATE SET
                  username=excluded.username, password_enc=excluded.password_enc,
                  token_enc=excluded.token_enc, updated_at=excluded.updated_at`)
      .run(domain, username, this._enc(password), this._enc(token), Date.now());
    return { ok: true, text: `已保存凭据 ${domain}（password=${password ? "已加密" : "无"} token=${token ? "已加密" : "无"}）` };
  }

  /**
   * 解密取回一个凭据（仅调用方确认 admin 后再调）。
   * @param {string} domain
   * @returns {{ok:boolean, domain?:string, username?:string, password?:string, token?:string, text?:string}}
   */
  get(domain) {
    const r = this.db.prepare("SELECT * FROM credentials WHERE domain = ?").get(domain);
    if (!r) return { ok: false, text: `未找到凭据 ${domain}` };
    return {
      ok: true,
      domain: r.domain,
      username: r.username,
      password: this._dec(r.password_enc),
      token: this._dec(r.token_enc),
    };
  }

  /** 列出所有凭据域名（不回显密码/token） */
  list() {
    const rows = this.db.prepare(
      "SELECT domain, username, updated_at, (password_enc != '') hasPass, (token_enc != '') hasToken FROM credentials ORDER BY domain"
    ).all();
    return rows;
  }

  /** 删除一个凭据 */
  remove(domain) {
    return this.db.prepare("DELETE FROM credentials WHERE domain = ?").run(domain).changes;
  }

  /** 生成适合拼进命令的 auth 片段（不回显明文值本身）：basic 或 bearer */
  authArg(domain, { style = "auto" } = {}) {
    const r = this.get(domain);
    if (!r.ok) return null;
    if (style === "bearer" && r.token) return `-H "Authorization: Bearer ${r.token}"`;
    if (style === "basic" && r.username && r.password) return `-u '${r.username}:${r.password}'`;
    if (r.token) return `-H "Authorization: Bearer ${r.token}"`;
    if (r.username && r.password) return `-u '${r.username}:${r.password}'`;
    return null;
  }

  close() {
    this.db?.close();
  }
}

export function createCredentialStore(opts) {
  return new CredentialStore(opts);
}
