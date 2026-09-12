#!/usr/bin/env node
/**
 * memory-cli —— PI2X 记忆库本地管理 CLI（不暴露给 QQ 对话）
 * 用法:
 *   node scripts/memory-cli.mjs stats
 *   node scripts/memory-cli.mjs list [--type pref] [--search 咖啡] [--limit 20]
 *   node scripts/memory-cli.mjs delete <id|--search 词>
 *   node scripts/memory-cli.mjs clear [--keep-pinned]
 *   node scripts/memory-cli.mjs harvest-log [--last-hours 24]
 *   node scripts/memory-cli.mjs warm            # 预热 embedding 模型（部署后跑一次）
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createMemoryStore } from "../lib/memory.mjs";

function Base64Id(content) {
  return Buffer.from(String(content).slice(0, 40)).toString("base64url").slice(0, 20);
}

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "config.json"), "utf8"));
const m = config.memory ?? {};
const dbPath = path.resolve(ROOT, m.dbPath ?? "./workspace/memories/memory.db");

const argv = process.argv.slice(2);
const cmd = argv[0];

function parseFlags(args) {
  const out = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const v = args[i + 1];
      out[k] = v === undefined || v.startsWith("--") ? true : v;
      if (out[k] !== true) i++;
    }
  }
  return out;
}

async function main() {
  const sc = m.scoring ?? {};
  const store = createMemoryStore({
    dbPath,
    modelDir: m.modelDir ? path.resolve(ROOT, m.modelDir) : undefined,
    harvestIntervalMs: (m.harvestIntervalMin ?? 10) * 60000,
    maxFacts: m.maxFacts ?? 500,
    injectChars: m.injectChars ?? 2500,
    harvestModel: m.harvestModel ?? "deepseek-chat",
    embedModel: m.embedModel,
    embedPrefixQuery: m.embedPrefixQuery ?? "",
    embedPrefixPassage: m.embedPrefixPassage ?? "",
    center: sc.center,
    useCsls: sc.useCsls,
    cslsK: sc.cslsK,
    gateSim: sc.gateSim,
    mergeSim: sc.mergeSim,
    relatedSim: sc.relatedSim,
    recencyDecay: sc.recencyDecay,
    evictMode: sc.evictMode,
    autoSupersede: sc.autoSupersede,
    weights: sc.weights,
  });

  switch (cmd) {
    case "stats": {
      const s = store.stats();
      console.log(`事实总数: ${s.total}（pinned ${s.pinned} · sensitive ${s.sensitive} · 带embedding ${s.embOk} · 已失效 ${s.invalid}）`);
      console.log("按类型:", s.byType.map((t) => `${t.type}=${t.c}`).join("  "));
      console.log(`平均重要性 ${s.avgImportance ?? "-"} · 累计使用次数 ${s.usedTotal} · 历史版本 ${s.history}`);
      console.log(`收割: ${s.harvest.count} 次，最近 ${s.harvest.lastTs ? new Date(s.harvest.lastTs).toLocaleString() : "无"}`);
      console.log(`全局常驻: ${s.globals} 条`);
      break;
    }
    case "geom": {
      console.log(JSON.stringify(store.geometryState(), null, 1));
      break;
    }
    case "calibrate": {
      console.log("实测向量空间分布（原始余弦 vs 去均值居中余弦）…");
      const c = store.calibrate();
      console.log(`条目 ${c.facts} · 采样对数 ${c.pairs}`);
      console.log("  原始  :", JSON.stringify(c.rawStats));
      console.log("  居中后:", JSON.stringify(c.centeredStats));
      console.log("  建议阈值:", JSON.stringify(c.suggest));
      break;
    }
    case "probe": {
      // 用一条查询看打分明细（验证几何修正效果）
      const qy = argv[1];
      if (!qy) { console.log("用法: probe <查询词> [--source private:xxx]"); break; }
      const f = parseFlags(argv.slice(2));
      const rows = await store.search({ keyword: qy, source: f.source, limit: 10 });
      if (!rows.length) { console.log("（无召回：被 gateSim 门槛拦下）"); break; }
      for (const r of rows) {
        console.log(
          `score=${r.score.toFixed(3)} cos=${(r.cos ?? -9).toFixed(3)} sim=${r.sim.toFixed(3)} ` +
          `rel=${r.relevance.toFixed(2)} [${r.type}] ${String(r.content).slice(0, 50)}`
        );
      }
      break;
    }
    case "reflect": {
      const f = parseFlags(argv.slice(1));
      const src = f.source ? String(f.source) : undefined;
      console.log(`反思合成（来源 ${src ?? "全部"}，窗口 ${f.hours ?? m.reflect?.hours ?? 336}h）…`);
      const r = await store.reflect({
        source: src,
        hours: Number(f.hours ?? m.reflect?.hours ?? 336),
        limit: Number(f.limit ?? m.reflect?.limit ?? 80),
        log: (s) => console.log(s),
      });
      console.log(`完成：新增洞见 ${r.created} 条${r.reason ? `（${r.reason}）` : ""}`);
      break;
    }
    case "history": {
      const id = argv[1];
      const rows = store.history(id && !id.startsWith("--") ? id : null);
      if (!rows.length) { console.log("（无历史版本）"); break; }
      for (const r of rows) {
        console.log(`${r.fact_id} [${new Date(r.replaced_at).toLocaleString()}] ${r.reason}: ${String(r.content).slice(0, 60)}`);
      }
      break;
    }
    case "superseded": {
      const rows = store.superseded();
      if (!rows.length) { console.log("（无已失效条目）"); break; }
      for (const r of rows) {
        console.log(`${r.id} [${r.type}] ${String(r.content).slice(0, 60)} → 失效于 ${new Date(r.valid_until).toLocaleString()}（被 ${r.superseded_by} 覆盖）`);
      }
      console.log(`共 ${rows.length} 条`);
      break;
    }
    case "list": {
      const f = parseFlags(argv.slice(1));
      const rows = store.list({ type: f.type, search: f.search, limit: Number(f.limit ?? 50) });
      if (!rows.length) { console.log("（无记录）"); break; }
      for (const r of rows) {
        console.log(
          `${r.id}  [${r.type}${r.pinned ? "★" : ""}${r.sensitive ? "🔒" : ""}] ${r.content}` +
          `\n     ts=${new Date(r.ts).toISOString()} source=${r.source} tags=${r.tags} used=${r.useCount}`
        );
      }
      break;
    }
    case "delete": {
      const f = parseFlags(argv.slice(2));
      const target = argv[1];
      const n = f.search ? store.deleteBySearch(String(f.search)) : target ? store.deleteById(target) : 0;
      console.log(`已删除 ${n} 条`);
      break;
    }
    case "clear": {
      const f = parseFlags(argv.slice(2));
      const n = store.clear(f["keep-pinned"] !== false);
      console.log(`已清空 ${n} 条（${f["keep-pinned"] === false ? "含 pinned" : "保留 pinned"}）`);
      break;
    }
    case "harvest-log": {
      const f = parseFlags(argv.slice(1));
      const rows = store.harvestLog({ lastHours: Number(f["last-hours"] ?? 24) });
      if (!rows.length) { console.log("（近 24h 无收割记录）"); break; }
      for (const r of rows) {
        console.log(`[${new Date(r.ts).toISOString()}] ${r.session} user=${r.user_id} +${r.count}条`);
      }
      break;
    }
    case "perms": {
      const rows = store.userPerms();
      if (!rows.length) { console.log("（无记录：仅 op/deop 操作会写入）"); break; }
      for (const r of rows) {
        console.log(`${r.user_id}  preset=${r.preset}  ${new Date(r.updated_at).toISOString()}  by=${r.updated_by}`);
      }
      break;
    }
    case "warm": {
      console.log("预热 embedding 模型（首次可能下载 ~100MB 经 hf-mirror）…");
      const vec = await store.embed("预热");
      console.log(vec ? `embedding 可用（${vec.length} 维）` : `embedding 不可用：${store.embedderState().error ?? "未知"}`);
      console.log("模型:", JSON.stringify(store.embedderState()));
      break;
    }
    case "embedder": {
      const st = store.embedderState();
      const vec = await store.embed("探测", "query");
      console.log(JSON.stringify({ ...st, canEmbed: !!vec, probedDim: vec?.length ?? 0 }, null, 1));
      break;
    }
    case "reembed": {
      // 换模型/修复维度不一致后：重建全部向量
      console.log(`重建向量：模型 ${store.embedModel} → ${store._EMB_DIM} 维（合并阈值 ${store.mergeSim}）`);
      const probe = await store.embed("探测", "passage");
      if (!probe) { console.log(`embedding 不可用，已中止：${store.embedderState().error ?? "未知"}`); break; }
      const r = await store.reembedAll((s) => console.log(s));
      console.log(`完成：共 ${r.total} 条，成功 ${r.ok}，失败 ${r.fail}`);
      break;
    }
    case "verify": {
      const f = parseFlags(argv.slice(1));
      const fix = f.fix === "true" || f.fix === "1";
      console.log(`一致性自检（向量 ⇄ 内容）${fix ? "并修复" : "（只检查，加 --fix true 修复）"}…`);
      const r = await store.verifyConsistency(fix, (s) => console.log(s));
      console.log(`检查 ${r.checked} 条，不符 ${r.bad} 条${fix ? `，已修复 ${r.fixed} 条` : ""}`);
      break;
    }
    case "dupes": {
      const f = parseFlags(argv.slice(1));
      const th = Number(f.threshold ?? store.mergeSim);
      const dups = store.findDuplicates(th);
      if (!dups.length) { console.log(`（无相似度 > ${th} 的重复对）`); break; }
      console.log(`相似度 > ${th} 的重复对 ${dups.length} 组：`);
      for (const d of dups) console.log(`  ${d.sim.toFixed(4)}  ${d.a.c.slice(0, 40)}  ↔  ${d.b.c.slice(0, 40)}`);
      break;
    }
    case "dedupe": {
      const f = parseFlags(argv.slice(1));
      const th = Number(f.threshold ?? store.mergeSim);
      if (f.apply !== "true" && f.apply !== "1") { console.log(`预览模式（加 --apply true 执行）：阈值 ${th}`); }
      const r = store.dedupe(th, (s) => console.log(s));
      if (f.apply === "true" || f.apply === "1") console.log(`已合并 ${r.removed} 组重复（扫描命中 ${r.scanned} 组）`);
      else console.log(`
预览：将合并 ${r.removed} 组（未执行）`);
      break;
    }
    case "add": {
      // 人工录入事实：add <内容> [--type pref] [--pin] [--sensitive] [--tags a,b]
      const f = parseFlags(argv.slice(2));
      const content = argv.slice(1).join(" ").replace(/\s*--type.*$/, "").replace(/\s*--tags.*$/, "").replace(/\s*--pin.*$/, "").replace(/\s*--sensitive.*$/, "").trim();
      if (!content) { console.log("用法: add <内容> [--type pref|fact|promise|event] [--pin] [--sensitive]"); break; }
      const type = f.type || "fact";
      const emb = await store.embed(content, "passage");
      if (!emb) { console.log("embedding 不可用，无法录入：" + (store.embedderState().error ?? "未知")); break; }
      const id = Base64Id(content);
      store.db.prepare("INSERT OR REPLACE INTO facts (id, type, content, tags, source, ts, lastUsed, pinned, sensitive, embedding) VALUES (?,?,?,?,?,?,?,?,?,?)")
        .run(id, type, content, JSON.stringify(String(f.tags ?? "").split(",").filter(Boolean)), "cli", Date.now(), Date.now(), f.pin ? 1 : 0, f.sensitive ? 1 : 0, Buffer.from(emb.buffer));
      console.log(`已录入 ${content} [${type}${f.pin ? "·pinned" : ""}${f.sensitive ? "·敏感" : ""}] id=${id}`);
      break;
    }
    case "export": {
      const rows = store.list({ limit: 100000 });
      const outFile = argv[1] ?? "/tmp/memory-export.json";
      fs.writeFileSync(outFile, JSON.stringify(rows, null, 2));
      console.log(`已导出 ${rows.length} 条 → ${outFile}`);
      break;
    }
    case "evicted": {
      const rows = store.evicted();
      if (!rows.length) { console.log("（无归档记录）"); break; }
      for (const r of rows) console.log(`${r.id} [${r.type}] ${r.content} · ${new Date(r.evicted_at).toLocaleString()}（used=${r.use_count}）`);
      console.log(`共 ${rows.length} 条`);
      break;
    }
    default:
      console.log(`用法: node scripts/memory-cli.mjs stats|list|delete|clear|harvest-log|perms|warm|add|export|evicted|geom|calibrate|probe|reflect|history|superseded`);
  }
  store.close();
}

main().catch((e) => { console.error(e); process.exit(1); });