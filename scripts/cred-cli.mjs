#!/usr/bin/env node
/**
 * PI2X 凭据管理 CLI —— 在 Linux 服务器上录入/管理凭据（不在 QQ 明文发）。
 *
 * 用法：
 *   node scripts/cred-cli.mjs add <域名> [--user u] [--pass p] [--token t]
 *   node scripts/cred-cli.mjs list
 *   node scripts/cred-cli.mjs get <域名>       # 解密回显（谨慎，仅本机）
 *   node scripts/cred-cli.mjs del <域名>
 */
import { createCredentialStore } from "../lib/credentials.mjs";

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseFlags(args) {
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith("--")) {
      const k = args[i].slice(2);
      const v = args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : "";
      flags[k] = v;
      if (v) i++;
    }
  }
  return flags;
}

const store = createCredentialStore();

function main() {
  try {
    if (cmd === "add") {
      const domain = argv[1];
      if (!domain) { console.log("用法: add <域名> [--user u] [--pass p] [--token t]"); return; }
      const f = parseFlags(argv.slice(2));
      const r = store.set({ domain, username: f.user || "", password: f.pass || "", token: f.token || "" });
      console.log(r.text);
    } else if (cmd === "list") {
      const rows = store.list();
      if (!rows.length) { console.log("（无凭据）"); return; }
      console.log("凭据列表:");
      for (const r of rows) console.log(`- ${r.domain}${r.username ? ` (${r.username})` : ""}${r.hasPass ? " [密码]" : ""}${r.hasToken ? " [token]" : ""}`);
    } else if (cmd === "get") {
      const domain = argv[1];
      if (!domain) { console.log("用法: get <域名>"); return; }
      const r = store.get(domain);
      if (!r.ok) { console.log(r.text); return; }
      console.log(`${r.domain}: 用户=${r.username || "-"} 密码=${r.password || "-"} token=${r.token || "-"}`);
    } else if (cmd === "del" || cmd === "remove") {
      const domain = argv[1];
      if (!domain) { console.log("用法: del <域名>"); return; }
      const n = store.remove(domain);
      console.log(n ? `已删除凭据 ${domain}` : `未找到 ${domain}`);
    } else {
      console.log("用法: node scripts/cred-cli.mjs add|list|get|del");
    }
  } finally {
    store.close();
  }
}

main();
