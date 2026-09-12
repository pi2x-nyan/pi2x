import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

/**
 * 运行期 import 路径有效性 —— 抓「文件搬运后相对路径没跟着改」这类 bug
 *
 * 【为什么需要】
 * 语法检查（node --check）**只看语法**，不看模块能否解析；
 * 静态 import 会在模块加载时立刻报错，还算容易发现；
 * 但 `await import("./x.mjs")` 是**运行到那一行才解析**，可能潜伏很久。
 *
 * 真实事故：把 _buildTools 从 lib/piagent.mjs 拆到 lib/tools/ 之后，
 * 凭据工具里的 `await import("./credentials.mjs")` 变成了引用它**自己**
 * （在 lib/tools/ 下解析成 lib/tools/credentials.mjs），
 * 于是 save_credential / get_credential 报「createCredentialStore is not a function」——
 * 整整一天后才被一次真实调用撞出来。这个测试就是为了那次事故。
 */

/** 递归收集项目内的 .mjs（跳过 node_modules / tmp / 测试夹具） */
function runtimeFiles() {
  const out = [];
  const skip = new Set(["node_modules", "tmp", "sessions", "logs", "state", "sandbox", "workspace", "agent-dir", "browser-profile", "browser-profile-op", "napcat", "win-agent"]);
  const walk = (dir) => {
    let names;
    try {
      names = fs.readdirSync(dir);
    } catch {
      return;
    }
    for (const n of names) {
      if (n.startsWith(".") || skip.has(n)) continue;
      const full = path.join(dir, n);
      let st;
      try {
        st = fs.statSync(full);
      } catch {
        continue;
      }
      if (st.isDirectory()) walk(full);
      else if (n.endsWith(".mjs")) out.push(full);
    }
  };
  walk(ROOT);
  return out;
}

/** 抽取源码里所有静态与动态 import 的说明符 */
function importSpecifiers(src) {
  const out = [];
  const re =
    /(?:^|\n)\s*import\s+(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']|(?:^|\n)\s*(?:const|let|var)\s+[^=\n]+=\s*await\s+import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*(?:return\s+)?await\s+import\(\s*["']([^"']+)["']\s*\)|(?:^|\n)\s*(?:const|let|var)?\s*[^=\n]*=\s*import\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1] ?? m[2] ?? m[3] ?? m[4];
    if (spec) out.push(spec);
  }
  return out;
}

/** 解析相对说明符并判断目标是否存在（含目录 index.mjs / package.json main） */
function resolves(spec, fromFile) {
  if (!spec.startsWith(".") && !spec.startsWith("/")) return true; // 包名交给 node 解析
  const abs = spec.startsWith("/") ? spec : path.resolve(path.dirname(fromFile), spec);
  if (fs.existsSync(abs) && fs.statSync(abs).isFile()) return true;
  if (fs.existsSync(`${abs}.mjs`) || fs.existsSync(`${abs}.js`)) return true;
  if (fs.existsSync(abs) && fs.statSync(abs).isDirectory()) {
    if (fs.existsSync(path.join(abs, "index.mjs"))) return true;
    if (fs.existsSync(path.join(abs, "package.json"))) return true;
  }
  return false;
}

test("所有运行期 import 的相对路径都必须能解析到真实文件", () => {
  const bad = [];
  for (const f of runtimeFiles()) {
    if (f.includes(`${path.sep}test${path.sep}`)) continue; // 测试文件另算
    const src = fs.readFileSync(f, "utf8");
    for (const spec of importSpecifiers(src)) {
      if (!resolves(spec, f)) bad.push(`${path.relative(ROOT, f)} → ${spec}`);
    }
  }
  assert.deepEqual(bad, [], `以下 import 路径解析不到目标：\n  ${bad.join("\n  ")}`);
});

test("回归：lib/tools/ 下的模块不得用 ./ 引用 lib/ 根下的模块", () => {
  // 这正是凭据工具事故的形态：文件在 lib/tools/ 里，却写 ./credentials.mjs
  const dir = path.join(ROOT, "lib", "tools");
  const offenders = [];
  const libRootNames = fs
    .readdirSync(path.join(ROOT, "lib"))
    .filter((n) => n.endsWith(".mjs"))
    .map((n) => n.replace(/\.mjs$/, ""));
  for (const n of fs.readdirSync(dir).filter((x) => x.endsWith(".mjs"))) {
    const src = fs.readFileSync(path.join(dir, n), "utf8");
    for (const spec of importSpecifiers(src)) {
      const m = /^\.\/([A-Za-z0-9_-]+)\.mjs$/.exec(spec);
      if (!m) continue;
      // 只有当「本地确实没有这个文件」而「lib/ 根下有同名模块」时才判定为层级写错。
      // lib/tools/ 与 lib/ 存在同名文件（memory.mjs、credentials.mjs…），
      // 不加这个判断会产生误报。
      const localExists = fs.existsSync(path.join(dir, `${m[1]}.mjs`));
      const rootExists = libRootNames.includes(m[1]);
      if (!localExists && rootExists) {
        offenders.push(`lib/tools/${n} → ${spec}（本地无此文件，应改为 ../${m[1]}.mjs）`);
      }
    }
  }
  assert.deepEqual(offenders, [], `相对路径写错层级：\n  ${offenders.join("\n  ")}`);
});

test("凭据工具能真正加载 createCredentialStore（覆盖那次事故的具体路径）", async () => {
  const mod = await import("../lib/tools/credentials.mjs");
  assert.equal(typeof mod.createCredentialTools, "function");
  const perms = new Set(["files:full"]);
  const tools = mod.createCredentialTools({ perms });
  const save = tools.find((t) => t.name === "save_credential");
  assert.ok(save, "应有 save_credential");
  // 走一次真实调用：失败会以「保存凭据失败: createCredentialStore is not a function」形式返回
  const r = await save.execute("t", { domain: "pi2x-selftest.invalid", token: "self-test" }, {}, {});
  const text = r.content.map((c) => c.text).join("");
  assert.doesNotMatch(text, /is not a function/, `动态 import 仍失败：${text}`);
  assert.doesNotMatch(text, /Cannot find (module|package)/, `模块解析仍失败：${text}`);
  // 清理
  const r2 = await save.execute("t", { domain: "pi2x-selftest.invalid", token: "self-test" }, {}, {});
  assert.ok(r2, "重复保存不应抛错");
  try {
    const { createCredentialStore } = await import("../lib/credentials.mjs");
    const cs = createCredentialStore();
    cs.delete?.("pi2x-selftest.invalid");
    cs.close();
  } catch {
    /* 清理失败不影响断言 */
  }
});
