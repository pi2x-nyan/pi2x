#!/usr/bin/env node
/**
 * QQ 非核心工具 CLI —— 供 bash 按需调用（skill: qq-tools 渐进披露，不注入 pi 工具清单）
 *
 * 核心对话工具（qq_send_message / qq_send_file）仍为 pi 工具，不在此列。
 *
 * 用法（--as <userId> 为当前会话用户，用于权限判定）：
 *   node scripts/qq-cli.mjs --as <uid> group_history <gid> [count]
 *   node scripts/qq-cli.mjs --as <uid> msg_detail <messageId>
 *   node scripts/qq-cli.mjs --as <uid> friend_list
 *   node scripts/qq-cli.mjs --as <uid> group_list
 *   node scripts/qq-cli.mjs --as <uid> ocr <本地图片路径>
 *   node scripts/qq-cli.mjs --as <uid> group_file_url <gid> <file_id> <busid>
 *   node scripts/qq-cli.mjs --as <uid> download <url> [timeoutSec]
 *   node scripts/qq-cli.mjs --as <uid> delete_msg <messageId>
 *   node scripts/qq-cli.mjs --as <uid> napcat <action> <jsonParams>
 *   node scripts/qq-cli.mjs --as <uid> op <targetUid> <preset>
 *   node scripts/qq-cli.mjs --as <uid> deop <targetUid>
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const WHITELIST_FILE = path.join(ROOT, "whitelist.json");
const { createWhitelist } = await import(path.join(ROOT, "lib", "whitelist.mjs"));
const { QQBridge } = await import(path.join(ROOT, "lib", "qqbridge.mjs"));
const { checkGrant, checkRevoke, levelOf, PRESET_LEVEL } = await import(path.join(ROOT, "lib", "op-policy.mjs"));
const { riskOf } = await import(path.join(ROOT, "lib", "napcat-api.mjs"));

// ── 参数解析 ──
let uid = "";
const args = [];
for (let i = 2; i < process.argv.length; i++) {
  if (process.argv[i] === "--as" && process.argv[i + 1]) { uid = String(process.argv[i + 1]); i++; }
  else args.push(process.argv[i]);
}
const [action, ...rest] = args;

// ── 权限判定 ──
const PERM = {
  group_history: "tools.group_history",
  msg_detail: "tools.get_msg",
  friend_list: "tools.friend_list",
  group_list: "tools.group_list",
  ocr: "tools.ocr",
  group_file_url: "tools.group_file",
  download: "tools.download",
  delete_msg: "tools.delete_msg",
  napcat: "tools.napcat",
  op: "tools.op",
  deop: "tools.op",
};
function permsOf(userId) {
  const wl = createWhitelist(WHITELIST_FILE);
  return new Set(wl.perms(String(userId)));
}
function requirePerm(token) {
  const p = permsOf(uid || "0");
  if (!p.has(token)) {
    console.log(`权限不足：${action} 需要「${token}」，当前用户 ${uid || "?"} 没有该权限。`);
    process.exit(1);
  }
}

// ── 权限等级：统一由 lib/op-policy.mjs 提供（与 /op 内置命令共用同一份实现） ──
//
// 【历史教训】这里原先有一段「配置项 allowOpEscalation 为 true 就整个
// 跳过等级校验」的分支，而 config.json 里它确实是 true（测试残留）——
// 后果是**任何 operator 都能把自己提成 admin**（admin = files:full，可读全盘、可取凭据）。
// 该开关已彻底删除：不留「一键关掉安全检查」的后门；真要演练请在测试里用假白名单。
//
// 另外，原先的拒绝文案会带上双方等级数字（如「其当前等级(3)不低于你(2)」），
// 等于把对方权限等级告诉调用者 —— 群成员可以靠试错探出谁有权限。
// 现在改为不带数字的说法。

/**
 * 把下载产物交给调用者。
 *
 * 【为什么要搬一次】
 * NapCat 的 download_file 把文件下载到**主进程侧**（其工作目录在 /root 下）。
 * 沙盒用户（operator 等）的沙箱是白名单挂载，看不到那里 ——
 * 于是「下载成功但自己读不到」，能力形同虚设。
 * 这里统一把文件复制进调用者自己的沙盒目录再返回该路径。
 *
 * admin（files:full）本来就能读全盘，直接返回原路径，不做多余拷贝。
 */
function deliverToUser(file, asUser) {
  const src = typeof file === "string" ? file : (file?.path ?? null);
  if (!src) return file; // 拿到的是结构化结果而非路径，原样返回
  try {
    const wl = createWhitelist(WHITELIST_FILE);
    if (wl.perms(String(asUser)).has("files:full")) return src;
    if (!fs.existsSync(src)) return src; // 不是本地文件（可能是 URL），原样返回
    const sandboxDir = path.resolve(ROOT, config.memory?.sandboxDir ?? "./sandbox", String(asUser));
    const dest = path.join(sandboxDir, "downloads", path.basename(src));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    return `${dest}（${fs.statSync(dest).size} 字节，已放入你的沙盒）`;
  } catch (e) {
    return `${src}（复制到沙盒失败：${e?.message}）`;
  }
}

// ── op/deop：直接改 whitelist.json（带与 /op 命令同级的防提权校验） ──
function writePreset(targetUid, preset) {
  const d = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
  d.users = d.users ?? {};
  if (preset === null) delete d.users[String(targetUid)];
  else {
    if (!["friend", "operator", "admin"].includes(preset)) throw new Error(`未知预设 ${preset}（friend/operator/admin）`);
    d.users[String(targetUid)] = preset;
  }
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(d, null, 2), "utf8");
}

/** op/deop 防提权校验：返回拒绝原因（null=允许）；规则见 lib/op-policy.mjs */
function guardOp(authUid, targetUid, preset) {
  if (!targetUid || !/^\d+$/.test(String(targetUid))) return `目标 QQ 非法: ${targetUid}`;
  const d = JSON.parse(fs.readFileSync(WHITELIST_FILE, "utf8"));
  const callerPreset = d.users?.[String(authUid)];
  const targetPreset = d.users?.[String(targetUid)];
  const r =
    preset === null
      ? checkRevoke({ callerPreset, targetPreset, isTargetSelf: String(authUid) === String(targetUid) })
      : checkGrant({ callerPreset, targetPreset, preset });
  return r.ok ? null : r.text;
}

/** 写/管理类 OneBot API 前缀（仅 admin 可调用，防 operator 滥用群管理） */
const WRITE_API = /^(set_|delete_|kick_|ban_|mute_|dismiss_|send_|approve_|reject_|update_|upload_|set_qq_profile)/;

async function main() {
  if (!action) {
    console.log("用法: node scripts/qq-cli.mjs --as <uid> <group_history|msg_detail|friend_list|group_list|ocr|group_file_url|download|delete_msg|napcat|op|deop> ...");
    process.exit(0);
  }
  requirePerm(PERM[action] ?? `tools.${action}`);

  const nb = config.napcat.onebot;
  const bridge = new QQBridge({ host: nb.wsHost, port: nb.wsPort, token: nb.token });
  try {
    await bridge.connect();
    let out;
    switch (action) {
      case "group_history": {
        out = await bridge.getGroupMsgHistory(Number(rest[0]), Math.min(Number(rest[1] ?? 20), 50));
        break;
      }
      case "msg_detail": {
        out = await bridge.getMsg(Number(rest[0]));
        break;
      }
      case "friend_list": out = await bridge.getFriendList(); break;
      case "group_list": out = await bridge.getGroupList(); break;
      case "ocr": out = await bridge.ocrImage(String(rest[0])); break;
      case "group_file_url": {
        out = await bridge.getGroupFileUrl(Number(rest[0]), String(rest[1]), Number(rest[2]));
        break;
      }
      case "download": {
        const r = await bridge.downloadFile(String(rest[0]), 3, Math.min(Math.max(Number(rest[1] ?? 60), 15), 300) * 1000);
        const file = r?.data?.file ?? r?.file ?? r;
        out = deliverToUser(file, uid);
        break;
      }
      case "delete_msg": out = await bridge.deleteMsg(Number(rest[0])); break;
      case "napcat": {
        const params = rest[1] ? JSON.parse(rest[1]) : {};
        const act = String(rest[0] ?? "");
        // 写/管理类接口仅 admin；只读（get_/search_/…）对已授权用户放行。
        //
        // 【修的是真漏洞，不是写法问题】原先这里用 `levelOf(uid) < PRESET_LEVEL.admin`，
        // 但 levelOf / PRESET_LEVEL 两个符号**根本没导入**（本文件只导入了 checkGrant/checkRevoke）。
        // 后果分两层，都被实测复现：
        //   1) 命中 WRITE_API 时判据先求值 → ReferenceError，整条 napcat 路径不可用；
        //   2) 不命中该正则的接口（get_cookies / get_csrf_token / get_credentials /
        //      bot_exit / clean_cache / _del_group_notice …）——因 `&&` 短路，左侧为 false
        //      时右侧**根本不求值**，levelOf 从未被调用，守卫等于不存在，直接执行。
        //      这些接口在 lib/napcat-api.mjs 里全标了 RED，而 operator 预设带 tools.napcat，
        //      于是 operator 能直接取 QQ 登录凭据或搞破坏（实测 get_csrf_token 真的返回了 token）。
        //
        // 现在两道判据都保留并叠加，且**刻意选更严的一侧**（绝不因修 bug 而放松）：
        //   · riskOf(act) === "red"  → 风险表判定的破坏/凭证/控制类接口
        //   · WRITE_API.test(act)    → 原有的写/管理前缀（含 send_，保持原策略不变）
        if (levelOf(uid) < PRESET_LEVEL.admin && (riskOf(act) === "red" || WRITE_API.test(act))) {
          out = `拒绝：${act} 属管理/破坏类接口，仅管理员可调用`;
          break;
        }
        out = await bridge.api(act, params);
        break;
      }
      case "op": {
        const reason = guardOp(uid, rest[0], rest[1]);
        if (reason) { out = `拒绝：${reason}`; break; }
        writePreset(rest[0], rest[1]);
        out = `已授予 ${rest[0]} → ${rest[1]}`;
        break;
      }
      case "deop": {
        const reason = guardOp(uid, rest[0], null);
        if (reason) { out = `拒绝：${reason}`; break; }
        writePreset(rest[0], null);
        out = `已撤销 ${rest[0]} 的预设（回 dialog）`;
        break;
      }
      default: out = `未知操作 ${action}`; break;
    }
    console.log(JSON.stringify(out, null, 1)?.slice(0, 8000));
  } finally {
    bridge.close();
    process.exit(0);
  }
}

main().catch((e) => { console.log("错误: " + (e?.message ?? e)); process.exit(1); });