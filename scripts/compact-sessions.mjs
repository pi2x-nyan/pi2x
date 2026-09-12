#!/usr/bin/env node
/**
 * PI2X 会话压缩：遍历 sessions/ 下所有 .jsonl，逐个打开并 compact（压缩上下文历史）。
 * 用法: node scripts/compact-sessions.mjs [sessionFile...]  （不传参数=全部）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  DefaultResourceLoader,
  getAgentDir,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { createModelRuntime, resolveModel } from "../lib/model-config.mjs";
import { createLogger } from "../lib/log.mjs";
import { makeSettingsManager } from "../lib/agent/settings.mjs";

const log = createLogger("compact-cli");

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const SESSIONS_DIR = path.join(ROOT, "sessions");

const targets = process.argv.slice(2);

/**
 * 解析会话文件路径。
 *
 * 【踩过的坑】原先只用 `path.join(SESSIONS_DIR, t)`，于是传入
 * `sessions/xxx.jsonl` 会拼成 `sessions/sessions/xxx.jsonl` —— 文件不存在时
 * SessionManager 会**静默创建空会话**，压缩随即报「Nothing to compact (session too small)」，
 * 看起来像「会话太小不需要压缩」，实际是根本没打开到那个文件。
 * （急救流程里因此白跑一次，用户看到的上下文占用毫无变化。）
 * 现在依次尝试：原样相对当前目录 → 相对 sessions/ → 绝对路径。
 */
function resolveTarget(t) {
  const candidates = [];
  if (path.isAbsolute(t)) candidates.push(t);
  else {
    candidates.push(path.resolve(ROOT, t)); // 相对项目根（兼容 sessions/x.jsonl）
    candidates.push(path.join(SESSIONS_DIR, t)); // 相对 sessions 目录（兼容裸文件名）
  }
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return candidates[candidates.length - 1]; // 都不存在时返回最后一个，由后续报错
}

let files = targets.length
  ? targets.map(resolveTarget)
  : fs.existsSync(SESSIONS_DIR)
    ? fs.readdirSync(SESSIONS_DIR).filter((f) => f.endsWith(".jsonl")).map((f) => path.join(SESSIONS_DIR, f))
    : [];

// 压缩需要真正调用模型，因此必须先装配 provider（omniroute 是自定义 provider，
// 不注册的话 pi 自选模型会失败 —— 原先这里写死 model: undefined，
// 在本部署下必然报错，等于脚本不可用）。
let modelRuntime = null;
let model = null;
try {
  modelRuntime = await createModelRuntime({ logger: log });
  model = resolveModel(modelRuntime, { logger: log });
  log.info(`压缩模型: ${model?.id ?? "（SDK 自选）"}`);
} catch (e) {
  log.warn(`模型装配失败，将由 SDK 自选: ${e?.message}`);
}

console.log(`[compact] 将处理 ${files.length} 个会话文件`);

for (const file of files) {
  const name = path.basename(file);
  if (!fs.existsSync(file)) {
    console.log(`[compact] ${name}: 跳过 —— 文件不存在（${file}）`);
    continue;
  }
  let session = null;
  try {
    const loader = new DefaultResourceLoader({
      cwd: ROOT,
      agentDir: getAgentDir(),
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      systemPrompt: "（临时压缩会话，无特殊提示）",
    });
    await loader.reload();
    const { session: s } = await createAgentSession({
      cwd: ROOT,
      agentDir: getAgentDir(),
      resourceLoader: loader,
      sessionManager: SessionManager.open(file),
      settingsManager: makeSettingsManager(),
      modelRuntime,
      model,
    });
    session = s;
    const before = session.getContextUsage?.();
    // 注意用 sessionManager.buildSessionContext()：session 对象上没有同名方法
    const entryCount = session.sessionManager?.buildSessionContext?.()?.messages?.length ?? 0;
    console.log(
      `[compact] ${name}: 开启完毕（约 ${entryCount} 条消息` +
        `${before?.tokens != null ? ` · ${before.tokens} token · ${Number(before.percent).toFixed(1)}%` : ""}）…`
    );
    const t0 = Date.now();
    await session.compact();
    const after = session.getContextUsage?.();
    console.log(
      `[compact] ${name}: 完成 · ${((Date.now() - t0) / 1000).toFixed(1)}s` +
        `${after?.tokens != null ? ` · 压缩后 ${after.tokens} token · ${Number(after.percent).toFixed(1)}%` : ""}`
    );
  } catch (e) {
    console.log(`[compact] ${name}: 失败 -> ${e?.message?.slice(0, 120) ?? e}`);
  } finally {
    try { session?.dispose?.(); } catch {}
  }
}
console.log("[compact] 全部结束");