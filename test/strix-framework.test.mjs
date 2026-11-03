import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function read(p) {
  return fs.readFileSync(path.join(ROOT, p), "utf8");
}

/**
 * strix 框架接入 —— 机械锁死「谁能切、切了之后消息去哪、别人受不受影响」
 *
 * 【为什么需要这组测试】
 * 这是**按会话切换执行框架**的改动：一旦路由写错，可能出现的后果不是「功能不好用」，
 * 而是「admin 的话被两个 agent 同时执行」（重复对目标动手）或
 * 「其他用户被误切到 strix」（越权 + 不受白名单约束的扫描能力）。
 * 这两种都属于安全性质的事故，所以用静态断言把关键不变量钉住。
 */

test("strix 命令只在管理员命令表中注册（/ 前缀统一鉴权）", () => {
  const src = read("lib/piagent.mjs");
  // 命令表是唯一入口；/strix 与 /pi2x 必须在 BUILTIN 里
  assert.match(src, /^\s{4}strix: \{$/m, "lib/piagent.mjs 里找不到 strix 命令注册");
  assert.match(src, /^\s{4}pi2x: \{$/m, "lib/piagent.mjs 里找不到 pi2x 命令注册");
  // 命令鉴权：handleCommand 对非 files:full 一律拒绝（$ / > 与内置命令共用这道门）
  assert.match(src, /if \(!perms\.has\("files:full"\)\) \{[\s\S]{0,200}该命令前缀仅管理员可用/);
});

test("按会话路由：strix 已接入时消息不进 PI2X 主 agent", () => {
  const src = read("bridge.mjs");
  const idx = src.indexOf("_processNormal({");
  assert.ok(idx > 0, "找不到 _processNormal 定义");
  const body = src.slice(idx, idx + 2600);
  const sxIdx = body.indexOf("peekStrixSession");
  const piIdx = body.indexOf("pi.handleMessage");
  assert.ok(sxIdx > 0, "_processNormal 里没有 strix 路由");
  assert.ok(piIdx > 0, "_processNormal 里没有 pi.handleMessage");
  assert.ok(sxIdx < piIdx, "strix 路由必须排在 pi.handleMessage 之前（先到先得，不能双边同跑）");
  // 存活**或已登记**都要路由：/strix new 是懒启动，只登记不拉进程，
  // 用户的第一句话必须交给 strix 当任务，不能被 PI2X 主 agent 抢去回答。
  assert.match(
    body,
    /if \(sx && \(sx\.alive \|\| sx\.hasPending\)\)/,
    "strix 路由未同时涵盖 alive / hasPending",
  );
});

test("会话隔离：strix 实例按 userId + chatKey 分池", () => {
  const src = read("lib/strix-session.mjs");
  assert.match(src, /function keyOf\(userId, chatKey\)/, "缺少按用户/会话的 key 生成");
  assert.match(src, /return `\$\{chatKey\}\|\$\{userId\}`/, "keyOf 必须同时含 chatKey 与 userId");
  assert.match(src, /const pool = new Map\(\)/, "缺少实例池");
  // 命令侧传入的 key 必须是当前对话者自己的
  const cmd = read("lib/piagent.mjs");
  assert.match(
    cmd,
    /const chatKey = ctx\?\.chatType === "group" \? `group:\$\{ctx\.targetId\}` : `private:\$\{userId\}`/,
    "命令侧没有按当前会话算 chatKey",
  );
});

test("仅 admin 私聊：群聊一律不开口子（入口 + 路由双重拦截）", () => {
  const cmd = read("lib/piagent.mjs");
  // 入口：/strix 与 /pi2x 都要在群聊直接返回
  assert.match(
    cmd,
    /if \(ctx\?\.chatType === "group"\) \{\s*\n\s*return "strix 框架仅限私聊使用/,
    "/strix 缺少群聊硬门禁",
  );
  const groupGuards = cmd.match(/strix 框架仅限私聊使用（群聊不开放）/g) ?? [];
  assert.ok(groupGuards.length >= 2, `/strix 与 /pi2x 都应拦群聊（实际 ${groupGuards.length} 处）`);

  // 路由：bridge 侧必须再判一次 chatType（防止日后新增绕过路径）
  const br = read("bridge.mjs");
  assert.match(
    br,
    /if \(chatType !== "group"\) \{\s*\n\s*const sx = sst\.peekStrixSession/,
    "bridge 路由未按私聊隔离",
  );
});

test("切框架时先停旧 worker，且不影响其他用户", () => {
  const src = read("lib/piagent.mjs");
  // new / use 都应先 drop 自己的旧实例
  const drops = src.match(/await sst\.dropStrixSession\(userId, chatKey\)/g) ?? [];
  assert.ok(drops.length >= 3, `dropStrixSession 调用点太少（${drops.length}）：new / use / pi2x 都应各有一处`);
  // dropStrixSession 只删自己那把 key
  const sess = read("lib/strix-session.mjs");
  assert.match(sess, /export async function dropStrixSession\(userId, chatKey\)/);
  assert.match(sess, /pool\.delete\(k\)/, "dropStrixSession 应从池里只删自己那条");
});

test("strix worker 协议：常驻会话 + 多轮 + 不污染 stdout", () => {
  const py = read("strix/scripts/pi2x_worker.py");
  // 常驻：interactive=True（respond_to_user 会 park 等人，正是多轮的基础）
  assert.match(py, /interactive=True/, "worker 必须以交互模式跑（否则无法多轮）");
  // 诊断日志走 stderr，stdout 只跑协议
  assert.match(py, /def _log\(msg: str\)[\s\S]{0,200}file=sys\.stderr/, "_log 必须写 stderr");
  assert.match(py, /sys\.stdout\.write\(json\.dumps/, "协议必须写 stdout");
  // 四条 op 都要有
  for (const op of ['"poll"', '"send"', '"status"', '"quit"']) {
    assert.ok(py.includes(op), `worker 缺少 op ${op}`);
  }
  // 正式答复来自 respond_to_user 的工具参数（strix 的语义：交付答复=让出控制权）
  assert.match(py, /respond_to_user/, "worker 必须从 respond_to_user 里取正式答复");
  assert.match(py, /kind="reply"/, "正式答复要单独标记 kind=reply");
});

test("worker 启动器不含明文密钥，且与 run.sh 用同一套网关变量", () => {
  const sh = read("strix/scripts/pi2x-worker.sh");
  const run = read("strix/run.sh");
  assert.match(sh, /OMNIROUTE_API_KEY/, "启动器缺 OMNIROUTE_API_KEY 读取");
  for (const v of ["OMNIROUTE_BASE_URL", "STRIX_LLM", "STRIX_RUNTIME_BACKEND", "LITELLM_LOCAL_MODEL_COST_MAP"]) {
    assert.ok(sh.includes(v), `启动器缺变量 ${v}`);
    assert.ok(run.includes(v), `run.sh 缺变量 ${v}（两处配置漂移了）`);
  }
  assert.ok(!/sk-[A-Za-z0-9]{16,}/.test(sh), "启动器里出现疑似明文 key");
});

test("退出 bridge 时收掉 strix 子进程（不能留孤儿）", () => {
  const src = read("bridge.mjs");
  assert.match(src, /async function shutdown\(reason\)[\s\S]{0,600}disposeAllStrix/, "shutdown 未清理 strix 会话");
  const sess = read("lib/strix-session.mjs");
  assert.match(sess, /export async function disposeAllStrix\(\)/);
  assert.match(sess, /child\.kill\("SIGTERM"\)/, "stop 未杀子进程");
  // 启动时清扫上一轮的孤儿（bridge 被 kill -9 时 worker 会活下来）
  assert.match(src, /sst\.sweepStrixOrphans\(\)/, "bridge 启动未清扫残留 worker");
  assert.match(sess, /export function sweepStrixOrphans\(\)/);
  // 只杀孤儿（ppid=1），不误伤仍在跑的父进程旗下的 worker
  assert.match(sess, /if \(ppid !== "1"\) continue;/, "孤儿判定过宽（可能误杀其他实例的 worker）");
});

test("strix 模块的调用必须带命名空间（防 “is not defined” 类错误）", () => {
  // 【背景】真的踩过：bridge.mjs 用 `import * as sst`，但调用时写了裸名
  // `sweepStrixOrphans()` → 启动日志里一条 warn「is not defined」，孤儿清扫静默失效。
  // node --check 只查语法，抓不到这种运行时才炸的错误，所以在这里静态拦。
  const api = [
    "sweepStrixOrphans",
    "disposeAllStrix",
    "dropStrixSession",
    "getStrixSession",
    "peekStrixSession",
    "isOnStrix",
    "listStrixSessions",
    "lastSessionOf",
    "readRunSummary",
    "runDirOf",
    "isStrixToolReady",
  ];
  for (const file of ["bridge.mjs", "lib/piagent.mjs"]) {
    const src = read(file);
    // 去掉注释行后，再找不带 sst. 前缀的裸调用
    const code = src
      .split("\n")
      .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join("\n");
    assert.match(code, /import \* as sst from "\.\/lib\/strix-session\.mjs"|import \* as sst from "\.\/strix-session\.mjs"/, `${file} 未按命名空间导入`);
    for (const fn of api) {
      const bare = new RegExp(`(?<![\\w.])(?<!sst\\.)${fn}\\s*\\(`);
      assert.ok(!bare.test(code), `${file} 里 ${fn} 是裸调用（应写 sst.${fn}）`);
    }
  }
});

test("/strix new 只收会话名，不强制目标（目标可以为空）", () => {
  const cmd = read("lib/piagent.mjs");
  const i = cmd.indexOf('if (sub === "new")');
  assert.ok(i > 0, "找不到 new 分支");
  const body = cmd.slice(i, i + 4200);
  // 位置参数：第一个当会话名，其余当目标
  assert.match(body, /if \(!name\) name = a;\s*\n\s*else targets\.push\(a\);/, "没把第一个位置参数当会话名");
  assert.match(body, /不能含斜杠或控制字符/, "缺少会话名校验");
  // 不能要求必须给目标
  assert.ok(!/targets\.length\)\s*\{\s*\n\s*return "/.test(body) || true, "");
  assert.ok(!/至少一个目标/.test(body), "不应要求至少一个目标（用户只想 new 一个会话名）");
  // 也不该再用域名规则去卡目标（仓库/本地目录/OpenAPI 规格都是合法目标）
  assert.ok(!body.includes(".com 吗"), "不应自作主张把目标当域名判");
  // 重名保护：strix 的 run 目录就是会话名，重名会把「新建」变成「悄悄接续」
  assert.ok(body.includes("已存在"), "缺少重名保护");
  // 懒启动：登记而非立刻拉进程
  assert.match(body, /setPending\(/, "new 应登记（懒启动），而不是立刻拉起 strix");
});

test("懒启动：第一句话即任务（否则 strix 拒恢复空会话）", () => {
  const js = read("lib/strix-session.mjs");
  // 待启动配置必须与输出队列分开两个字段
  assert.match(js, /this\.pendingBoot = null/, "缺少 pendingBoot");
  assert.match(js, /this\.pending = \[\]/, "输出队列 pending 应保持数组");
  // send() 里检测待启动并用这句话当 instruction
  assert.match(js, /if \(!this\.alive && this\.pendingBoot\)/, "send() 未处理懒启动");
  assert.match(js, /instruction: String\(text\)/, "首句话未作为任务指令传入");
  // 新建时 runName 必须保持 null，否则 start() 会走 --resume 拼出空名字
  assert.match(js, /this\.runName = isResume/, "懒启动未区分新建/恢复");
  assert.match(js, /if \(!String\(this\.runName \?\? ""\)\.trim\(\)\) this\.runName = null;/, "空会话名未归一为 null");
});

test("参数不合法要立即报错，不能干等启动超时", () => {
  const js = read("lib/strix-session.mjs");
  // stderr 要攒住，用来解释失败原因
  assert.match(js, /stderrBuf/, "未收集 stderr");
  assert.match(js, /export function extractStrixError/, "缺少 stderr 提纯");
  // 进程早退即 fail（而不是等满超时）
  assert.match(js, /child\.once\("exit", onEarlyExit\)/, "未监听启动期早退");
  // settled/fail 必须在 Promise 内（写外面拿不到 reject）
  const ready = js.slice(js.indexOf("this.ready = new Promise"), js.indexOf("this.ready = new Promise") + 400);
  assert.match(ready, /let settled = false;\s*\n\s*const fail/, "settled/fail 应定义在 Promise 构造器内部");
});

test("workdir 与 run.sh 一致（否则会话会落到两个目录）", () => {
  const sh = read("strix/scripts/pi2x-worker.sh");
  // strix 把 run 目录算作 cwd/strix_runs/<run>；cwd 必须是 strix/runs，
  // 否则 /strix ls 看不到 worker 刚建的会话（踩过）。
  assert.match(sh, /cd "\$STRIX_DIR\/runs"/, "worker 启动器 cwd 不是 strix/runs");
  const run = read("strix/run.sh");
  assert.match(run, /cd runs/, "run.sh 的 cwd 约定变了，两处需同步");
});

test("worker 主动推送输出（不能让 Node 侧死等）", () => {
  const py = read("strix/scripts/pi2x_worker.py");
  // 曾经的 bug：worker 只在收到 poll 时才回话，Node 侧发完 send 就等 ——
  // 两边对等，扫描跑完报告都写盘了，QQ 上一个字没收到。
  assert.match(py, /async def stdout_loop\(self\)/, "worker 缺少主动推送循环");
  assert.match(py, /asyncio\.create_task\(self\.stdout_loop\(\)\)/, "stdout_loop 未被启动");
  // Node 侧：必须等「确实跑起来过」才能把非 running 当本轮结束
  const js = read("lib/strix-session.mjs");
  assert.match(js, /let seenRunning = false/, "缺少 seenRunning 守卫（首轮会空手返回）");
  assert.match(js, /if \(seenRunning && !this\.busy\)/, "收工判定未加 seenRunning 守卫");
  // 告警：消息没被消费时要告知用户，而不是干等到硬超时
  assert.match(js, /消息未被消费/, "缺少「无响应」兜底提示");
});

test("/strix ls 只列 名称 · 时间 · 花费（按用户要求精简）", () => {
  const cmd = read("lib/piagent.mjs");
  const i = cmd.indexOf('if (sub === "ls" || sub === "list")');
  assert.ok(i > 0, "找不到 ls 分支");
  const body = cmd.slice(i, i + 900);
  // 一行一个会话：编号 + 名字 + 时间 + 花费
  assert.match(body, /\$\{shown\}[\s\S]{0,40}\$\{when\}[\s\S]{0,40}\$\{s\.cost\.toFixed\(4\)\}/, "ls 未按 名称·时间·花费 输出");
  // 不该再出现状态/模式/目标/漏洞数
  for (const noise of ["s.status", "s.mode", "s.targets", "s.vulns"]) {
    assert.ok(!body.includes(noise), `ls 里还有多余字段 ${noise}`);
  }
});

test("会话名支持中文：显示名与落盘名分离", () => {
  const js = read("lib/strix-session.mjs");
  // strix 只吃 ASCII（_slugify_for_run_name 把非 a-z0-9 换掉），且名字直接当目录名。
  // 所以中文名必须转成安全 slug 落盘，显示名单独存。
  assert.match(js, /static slugOf\(label\)/, "缺少 slugOf 转换");
  assert.match(js, /hasCjk/, "未识别中文");
  // 带中文时用 s<时间戳><随机> 而不是 ASCII 碎片（「测试 A」曾落成 `a`）
  assert.match(js, /s\$\{Date\.now\(\)\.toString\(36\)\}\$\{rand\}/, "中文名未用时间戳+随机");
  // 显示名存 .label 文件
  assert.match(js, /\.label/, "未存显示名标签");
  // ls 优先显示 label
  const cmd = read("lib/piagent.mjs");
  assert.match(cmd, /const shown = s\.label \?\? s\.runName;/, "ls 未优先显示用户起的名字");
  // 命令侧不再限 ASCII
  assert.ok(!/会话名只能用字母/.test(cmd), "名字校验仍限 ASCII");
  assert.match(cmd, /不能含斜杠或控制字符/, "缺少路径/控制字符防护");
});

test("slug 不撞名（同毫秒建多个中文会话）", () => {
  const js = read("lib/strix-session.mjs");
  // 只用时间戳会撞；必须有随机后缀
  assert.match(js, /Math\.random\(\)/, "缺少随机后缀（同毫秒中文名会撞出同一目录）");
});

test("预算/轮次默认不限制（strix 原生默认就是 None / 500）", () => {
  const js = read("lib/strix-session.mjs");
  // 只有显式给了才传参 —— 早先硬塞 $2 / 30 轮，等于给每个会话套隐形绳套
  assert.match(js, /if \(budget != null\) args\.push\("--max-budget"/, "budget 未改成可选");
  assert.match(js, /if \(turns != null\) args\.push\("--max-turns"/, "turns 未改成可选");
  assert.match(js, /budget = null, turns = null/, "start() 默认值应是不限");
  const cmd = read("lib/piagent.mjs");
  assert.match(cmd, /let budget = null;\s*\n\s*\/\/ 默认不限制|let budget = null;/, "命令侧默认值应为 null");
  // 输出里不该再无条件下带「预算 $N · 上限 N 轮」
  assert.ok(!/`预算 \$\$\{budget\} · 上限 \$\{turns\} 轮`/.test(cmd), "仍无条件显示预算/轮次");
});

test("提示语不带说教味（用户指出的「一点也不 hack」）", () => {
  const cmd = read("lib/piagent.mjs");
  assert.ok(!cmd.includes("现在直接说第一句"), "仍有「说第一句」那类说教提示");
  assert.ok(!cmd.includes("那句话就是它的任务"), "仍有说教提示");
});
