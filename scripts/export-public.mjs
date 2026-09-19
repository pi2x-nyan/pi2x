#!/usr/bin/env node
/**
 * 导出公开版 —— 从本地仓库生成可安全发布的快照
 *
 * 【为什么需要独立导出，而不是直接 push 本地仓库】
 * 本地仓库是「完整版」：含本机配置、真人设、运维脚本里的一些部署信息。
 * 公开仓库需要的是另一份东西 —— 剥离了人设与所有身份/密钥信息的源码快照。
 * 两者内容不同、目的不同，混在一个仓库里迟早出错（一个手滑 push 就把人设公开了），
 * 所以物理隔离：本地仓库照常开发，公开版由本脚本生成。
 *
 * 【剥什么、为什么】
 *   prompt/context/2x-*.md   人设提示词 —— 属于作者的创作与私人设定，不随代码公开
 *   config.json / whitelist.json / .cc-pool.json / win-agent/config.json
 *                            含密钥与真实 QQ，改由 *.example.json 提供模板
 *   真实姓名、内网 IP、主机名、真实 QQ   —— 身份与拓扑信息
 *
 * 【安全闸门】
 * 导出（并初始化 git 仓库）后自动跑 scripts/scan-secrets.mjs。
 * **只要还有高危项就删除导出目录并失败** —— 不会留下「看起来能推其实不干净」的产物。
 *
 * 执行顺序（重要）：
 *   0) 工作区必须干净（否则导出内容与提交不一致）
 *   1) 复制 + 剥离 + 内容改写
 *   2) git init（让扫描器能按 git ls-files 精确统计）
 *   3) 安全扫描 ← 不过关则整目录删除
 *
 * 用法：
 *   node scripts/export-public.mjs                  # 导出到 tmp/public-export/
 *   node scripts/export-public.mjs --out <目录>     # 指定输出目录
 *   node scripts/export-public.mjs --no-git         # 不初始化 git 仓库
 *   node scripts/export-public.mjs --skip-scan      # 跳过扫描（不建议）
 */
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARGS = process.argv.slice(2);
const outIdx = ARGS.indexOf("--out");
const OUT = path.resolve(outIdx >= 0 ? ARGS[outIdx + 1] : path.join(ROOT, "tmp", "public-export"));
const NO_GIT = ARGS.includes("--no-git");
const SKIP_SCAN = ARGS.includes("--skip-scan");

/** 不进入公开版的文件 */
const EXCLUDE_PATTERNS = [
  // 人设提示词（作者的私人设定）。
  // 注意匹配的是 `2x`（不带横线）：统一人设后文件名为 2x.md，
  // 若仍写成 /^prompt\/context\/2x-/ 就会漏掉它、把私人人设导出到公开仓库。
  /^prompt\/context\/2x/,
  // 重构记录 REFACTOR-*.md：含大量本机部署细节、真实路径与排障过程
  // （包括密钥排查痕迹），按用户要求不上传公开仓库，仅本地保留。
  /^REFACTOR-.*\.md$/,
  /^\.private-terms$/,
  /^tmp\//,
  /^logs\//,
  /^state\//,
  /^sessions\//,
  /^sandbox\//,
  /^workspace\//,
  /^agent-dir\//,
  /^\.git\//,
];

/** 内容改写：把身份信息与本地设定换成通用说法 */
const REWRITES = [
  { file: /^config\.example\.json$/, from: /"2x"\s*:/g, to: '"default":' },
  { file: /^lib\/config\.mjs$/, from: /persona\.2x|"2x"/g, to: "persona" },
  { file: /\.(md|mjs|json|sh|ps1)$/, from: /<创建者>/g, to: "<创建者>" },
  // 本机部署路径归一化。
  //
  // 【为什么不能改本地文件】prompt/ 里的 `<PI2X_ROOT>/scripts/xxx.mjs` 是**运行时要用**的：
  // 模型照着它去执行脚本。改成占位符会让 bot 当场失效。
  // 所以只在导出副本里替换 —— 公开仓库看不到部署结构，clone 下来的人也不会被
  // 误导成"必须放在 <PI2X_ROOT>"。
  { file: /\.(md|mjs|json|sh|ps1)$/, from: /D:\\PI2X/g, to: "<PI2X_ROOT_WIN>" },
  { file: /\.(md|mjs|json|sh|ps1)$/, from: /\/opt\/pi2x/g, to: "<PI2X_ROOT>" },
  { file: /\.(md|mjs|json)$/, from: /10\.208\.\d+\.\d+/g, to: "<LAN_IP>" },
  { file: /\.(md|mjs|json)$/, from: /10\.126\.\d+\.\d+/g, to: "<OVERLAY_IP>" },
];

const TEXTISH = /\.(mjs|js|json|md|sh|ps1|txt|example|gitignore)$/;

function trackedFiles() {
  return execFileSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean);
}

function shouldExclude(rel) {
  return EXCLUDE_PATTERNS.some((re) => re.test(rel));
}

function rewriteContent(rel, text) {
  let out = text;
  for (const r of REWRITES) if (r.file.test(rel)) out = out.replace(r.from, r.to);
  return out;
}

function fail(msg) {
  console.error(`\n✗ ${msg}`);
  if (fs.existsSync(OUT)) {
    fs.rmSync(OUT, { recursive: true, force: true });
    console.error(`  已删除导出目录 ${OUT}（避免留下不干净的产物）`);
  }
  process.exit(1);
}

function main() {
  // ── 0) 工作区必须干净 ────────────────────────────────────────────────
  const dirty = execFileSync("git", ["-C", ROOT, "status", "--porcelain"], { encoding: "utf8" }).trim();
  if (dirty) {
    console.error("✗ 工作区有未提交改动，请先提交（否则导出内容与仓库不一致）：");
    console.error(dirty.split("\n").slice(0, 10).map((l) => `    ${l}`).join("\n"));
    process.exit(1);
  }

  // ── 1) 同步文件到导出目录（**保留 .git，累积提交历史**）──────────────
  //
  // 【为什么不再 rm -rf 重建】
  // 原实现每次删除整个导出目录、重新 git init，于是每份产物都只有一条 commit；
  // 推到远程再强推覆盖，远程永远只有一条历史，看不出演进过程。
  // 现在只清理「非 .git 的内容」，仓库本体留着，改动累积成新 commit。
  // 配套：推送改为普通 push（见文末提示），这样远程会正常累积历史。
  fs.mkdirSync(OUT, { recursive: true });
  // 清掉上次的产物文件（保留 .git），避免已删除文件残留在工作区
  for (const e of fs.readdirSync(OUT)) {
    if (e === ".git") continue;
    fs.rmSync(path.join(OUT, e), { recursive: true, force: true });
  }

  const files = trackedFiles();
  let copied = 0;
  const excluded = [];
  for (const rel of files) {
    if (shouldExclude(rel)) {
      excluded.push(rel);
      continue;
    }
    const src = path.join(ROOT, rel);
    const dst = path.join(OUT, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    if (TEXTISH.test(rel) || path.basename(rel).startsWith(".")) {
      fs.writeFileSync(dst, rewriteContent(rel, fs.readFileSync(src, "utf8")), "utf8");
    } else {
      fs.copyFileSync(src, dst);
    }
    copied++;
  }
  console.log(`【1/3】已导出 ${copied} 个文件 → ${OUT}`);
  if (excluded.length) {
    console.log(`        已剥离 ${excluded.length} 个文件：`);
    for (const e of excluded.slice(0, 12)) console.log(`          - ${e}`);
    if (excluded.length > 12) console.log(`          … 另有 ${excluded.length - 12} 个`);
  }

  // ── 2) git 提交（仓库若不存在才 init；有变化才新增 commit）──────────
  if (!NO_GIT) {
    try {
      if (!fs.existsSync(path.join(OUT, ".git"))) {
        execFileSync("git", ["init", "-q"], { cwd: OUT });
        // 默认分支统一为 main，避免 master/main 两套命名
        try { execFileSync("git", ["symbolic-ref", "HEAD", "refs/heads/main"], { cwd: OUT }); } catch { /* 老版本 git 无妨 */ }
        console.log("        导出目录首次创建：已 git init");
      }
      execFileSync("git", ["add", "-A"], { cwd: OUT });

      // 有暂存改动才提交（否则每次导出都会产生一条空提交，历史会变成噪音）
      const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: OUT, encoding: "utf8" }).trim();
      if (!staged) {
        const n = execFileSync("git", ["ls-files"], { cwd: OUT, encoding: "utf8" }).split("\n").filter(Boolean).length;
        console.log(`【2/3】内容无变化，跳过提交（${n} 个文件）`);
      } else {
        const files = staged.split("\n").filter(Boolean);
        const n = execFileSync("git", ["ls-files"], { cwd: OUT, encoding: "utf8" }).split("\n").filter(Boolean).length;
        // 提交信息带上「来源提交」与改动摘要，远程历史因此可追溯
        const srcHead = (() => {
          try { return execFileSync("git", ["-C", ROOT, "log", "-1", "--pretty=%h %s"], { encoding: "utf8" }).trim(); }
          catch { return ""; }
        })();
        const shown = files.slice(0, 8).map((f) => `- ${f}`).join("\n");
        const more = files.length > 8 ? `\n… 另有 ${files.length - 8} 个文件` : "";
        const msg = `sync: 从本地仓库导出（${files.length} 个文件变更）\n\n来源提交：${srcHead}\n\n变更文件：\n${shown}${more}`;
        execFileSync(
          "git",
          ["-c", "user.email=pi2x@localhost", "-c", "user.name=PI2X", "commit", "-q", "-m", msg],
          { cwd: OUT }
        );
        const total = execFileSync("git", ["rev-list", "--count", "HEAD"], { cwd: OUT, encoding: "utf8" }).trim();
        console.log(`【2/3】已提交 ${files.length} 个文件变更（共 ${n} 个文件，历史第 ${total} 条）`);
      }
    } catch (e) {
      fail(`git 提交失败：${e?.message}`);
    }
  } else {
    console.log("【2/3】已跳过 git 操作（--no-git）");
  }

  // ── 3) 安全扫描 ──────────────────────────────────────────────────────
  if (SKIP_SCAN) {
    // 【为什么加了这道闸门】#
    // 原先 --skip-scan 一敲就整段跳过扫描、退出码也不受影响 —— 一个“发布前唯一
    // 机械守住密钥的环节”就这么被一个顺手的参数关掉了，而且没有任何痕迹。
    // 现在改成需要双确认：得同时给 --skip-scan 与 --i-know-its-unsafe，
    // 并在输出里留下大声的告警（后人看日志能发现这次导出没扫过）。
    if (!ARGS.includes("--i-know-its-unsafe")) {
      console.error("✗ --skip-scan 已禁用：发布前的密钥扫描是最后一道机械闸门，不允许随手关掉。");
      console.error("  确实需要跳过（例如本地演练），请同时加上 --i-know-its-unsafe 表示你知情。");
      if (fs.existsSync(OUT)) {
        fs.rmSync(OUT, { recursive: true, force: true });
        console.error(`  已删除导出目录 ${OUT}（不留下未扫描的产物）`);
      }
      process.exit(1);
    }
    console.warn("\n  \u001b[41m ⚠ 本次导出**未经密钥扫描** \u001b[0m");
    console.warn("  该产物不得直接 push 到公开仓库；请事后手动跑：");
    console.warn(`      node scripts/scan-secrets.mjs --history\n`);
    console.log("【3/3】已跳过安全扫描（--skip-scan --i-know-its-unsafe）");
  } else {
    const scan = spawnSync(process.execPath, [path.join(ROOT, "scripts", "scan-secrets.mjs"), "--history"], {
      encoding: "utf8",
      env: { ...process.env, PI2X_SCAN_ROOT: OUT, FORCE_COLOR: "0" },
    });
    const out = `${scan.stdout ?? ""}${scan.stderr ?? ""}`;
    const summary = out.split("\n").filter((l) => /高危|中危|提示/.test(l)).join("\n");
    console.log("【3/3】安全扫描结果：");
    console.log(summary.split("\n").map((l) => `        ${l}`).join("\n"));

    const m = /高危\s+(\d+)/.exec(out);
    const high = m ? Number(m[1]) : -1;
    if (high !== 0) {
      console.error("\n" + out);
      fail("导出目录里仍存在高危项，已中止");
    }
  }

  console.log(`\n✓ 公开版就绪：${OUT}`);
  console.log(`\n推送方式（普通 push 即可，**不要用 --force** —— 那会把远程历史清成一条）：`);
  console.log(`    cd ${OUT}`);
  console.log(`    git remote add origin <你的公开仓库地址>   # 首次`);
  console.log(`    git push origin main`);
  console.log(`\n注：远程若仍是「每次强推覆盖」的旧历史，首次需 --force 对齐一次，`);
  console.log(`    之后就都是普通 push 累积了。`);
}

main();
