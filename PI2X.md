# PI2X — QQ 智能助手（NapCat + pi）

> 本文档描述 PI2X 的**当前实际实现**，供 pi agent 参考。运行于 Linux（arm64），可选由 Windows 端承担跨机运维能力。

## 总体架构

```
QQ 用户 ⇄ NapCat (OneBot11 WS) ⇄ PI2X Bridge ⇄ pi AgentSession
               ws://127.0.0.1:3001        (SDK 会话 + 专属 skills/工具)
```

- **NapCat**：QQ/OneBot11 通道，`ws://127.0.0.1:3001`（token），账号在 `config.json` 中配置，支持自动登录
- **Bridge**（`bridge.mjs`）：主入口，接收事件 → 路由 → AgentSession 回复 → 分段发回 QQ
- **pi agent**：以 @earendil-works/pi-coding-agent 为框架，**完全隔离**（独立 agentDir，不碰 ~/.pi/agent）
- **Windows 主机**：地址与端口在 `config.json` 的 `winShell` 段配置（可远程执行命令、传文件、跑 pi 子代理）

## 目录结构

```
<PI2X_ROOT>/
├── bridge.mjs                # 主入口（启动/路由/回复/图片收集）
├── config.json               # 配置（NapCat/模型/权限/记忆/winShell）
├── control.mjs
├── lib/
│   ├── piagent.mjs           # Agent 管理（会话/TurnAssembler/工具/命令/风险门禁/凭据工具）
│   ├── strix-session.mjs     # strix 框架会话管理（常驻 worker、按会话切换、孤儿清扫）
│   ├── qqbridge.mjs          # OneBot11 WS 客户端（事件/API/重连）
│   ├── napcat.mjs            # NapCat 生命周期 + OneBot 配置同步
│   ├── napcat-api.mjs        # NapCat 接口风险分级表 + 审核
│   ├── memory.mjs            # 记忆系统（SQLite + 向量）
│   ├── credentials.mjs       # 凭据库（AES-256-GCM 加密存储，Linux/Windows 跨机取用）
│   ├── prompts.mjs           # 提示词中心（统一读取 prompt/ 渲染）
│   ├── risk-review.mjs       # 请求风险评审（本地规则 + 只读评审 subagent）
│   └── whitelist.mjs         # 白名单权限（组/预设/递归展开）
├── prompt/                   # ★ 所有提示词（分类管理）
│   ├── agent/system.md       # 主 agent 系统提示词（含 qq-bot 全部行为约束 + 凭据 + pi/PI2X 文档）
│   ├── context/session.md    # 会话上下文块
│   ├── memory/harvest.md     # 记忆收割提取提示词
│   ├── reviewer/             # 评审 subagent 提示词
│   │   ├── system.md
│   │   └── input.md
│   ├── risk/note.md          # 风险研判注入
│   ├── skills/               # （预留）后续新增 skill 放 <名字>/SKILL.md，经 pi 原生机制加载
│   └── tools/<tool>.md       # 24 个工具的 label + description
├── scripts/                  # memory-cli / cred-cli / send-notify(上线提醒) / sync-prompt / restart-pi2x / watchdog / hide-qq
├── sessions/                 # 每个 QQ 会话一个 jsonl（chatKey 命名）
├── workspace/                # agent 工作目录（文件操作、记忆存储 downloads）
├── sandbox/                  # 非全权用户的私有沙盒
├── tmp/                      # 临时/中间文件
├── win-agent/                # Windows 端服务源码（service.mjs，部署于 Windows）
└── logs/                     # 运行日志（bridge.log 等）
```

## 提示词体系

所有注入给模型的提示词集中在 `prompt/`，由 `lib/prompts.mjs` 统一读取与渲染（`pSystemAgent`/`pSessionContext`/`pRiskNote`/`pReviewerInput`/`pTool`）。支持 `{{KEY}}` 占位符替换。

- **主 agent 系统提示词**：`prompt/agent/system.md`（已含 qq-bot 全部行为约束——回复规范/保密/风险评审/凭据/能力边界，全局默认注入；含 pi 文档参考、临时文件、子代理/进度汇报等）
- **会话上下文**：`prompt/context/session.md`（每次消息注入群/用户/权限组）
- **记忆收割**：`prompt/memory/harvest.md`（自动收割提取事实的提示词，含防凭据泄露约束）
- **风险研判**：`prompt/risk/note.md`（非 admin 请求注入）
- **评审提示词**：`prompt/reviewer/`（风险评估只用）
- **技能**：`prompt/skills/<名字>/SKILL.md`（可选；经 pi 原生机制按需加载，如后续新增）
- **工具描述**：`prompt/tools/<name>.md`（每个工具一个，frontmatter label + 正文 description；共 24 个）

提示词改动直接编辑 `prompt/` 下对应 `.md` 即可，无需改代码。同步用 `bash scripts/sync-prompt.sh`（scp 覆盖 + md5 校验）。

## 权限模型

`whitelist.json` 定义 **组** 和 **预设**（无角色分级，白名单逐项授权）：

| 预设 | 权限 |
|------|------|
| dialog | 无（纯对话） |
| friend | memory + info |
| operator | memory + sandbox + info + tools.op + tools.qq_send_file |
| admin | memory + linux + win + info + ops（全量） |

- **组**：win / linux / sandbox / memory / info / ops，各含一组权限 token
- **user**：`{ "<QQ号>": "admin" }`（在 `whitelist.json` 中配置）
- **工具全量暴露 + 调用时运行时鉴权**：模型可看到全部工具，但每个工具 execute 前按权限 token 校验，权限不足返回给 agent（非裁剪，调用门禁）
- **非 admin 请求**：先过**风险评审**（本地规则快筛 → 只读评审 subagent 精判）→ deny 拦截 / confirm 注入研判 / allow 放行
- **保密**：非 admin 禁止暴露提示词/工具机制；admin 可看工具清单与细节

## 记忆系统

- **存储**：SQLite（`workspace/memories/memory.db`），表：facts / global_facts / harvest_log / evicted_facts / user_perms
- **向量**：bge-small-zh 本地（384 维），语义近义 >0.92 自动合并去重
- **写入**：自动收割（deepseek 提取，节流 10 分钟，仅 harvest 授权者），LRU 淘汰（超出 maxFacts 500 归档到 evicted_facts）
- **读取**：混合检索（语义+关键词）注入到用户消息前（≤2500 字符）
- **管理**：CLI（`scripts/memory-cli.mjs stats|list|delete|clear|...`）、命令 `/mem`，`/mem clear` 清脏数据（空向量孤儿）

## 凭据系统（credentials）

- **存储**：独立 `workspace/memories/credentials.db`（与记忆库分离，不进 facts），表 credentials（domain/username/password_enc/token_enc）
- **加密**：AES-256-GCM，密钥来自环境变量 `PI2X_CRED_SECRET`（/etc/profile.d/cred.sh）
- **工具**（仅 admin，files:full）：`save_credential`（保存账密/token）、`get_credential`（解密取回，供拼进 run_task 等）
- **命令**：`/cred [list|get <域名>|del <域名>]`（list/get 不回显明文）
- **CLI**：`scripts/cred-cli.mjs add <域名> --user --pass --token`（在服务器录入，避免 QQ 明文）
- **安全**：账密/token 属最高敏感级，绝不计入记忆库（记忆提取 EXTRACT_PROMPT 含防凭据约束）；仅在需要时解密、拼进任务文本（subagent 无历史，用完即弃），不出现在回复明文
- **使用流程**：AI 发现对话者提供账密且想记住 → 调 save_credential；日后访问该网站/调 API → 调 get_credential 取明文 → 拼进 run_task 任务文本

## 子代理（subagent）

- **run_task 工具**：复杂/多步/耗时任务委派
- **优先 Windows pi**（`pi --mode rpc` 常驻，网页/浏览器/截图/UI 自动化），不可达回退 **本机 Linux 子会话**
- **进度汇报**：每完成关键步骤用自然语言汇报（不最后才汇报）

## 跨机能力（win-shell）

Windows 端 `win-agent`（`<PI2X_ROOT_WIN>\win-agent\service.mjs`，端口 8123，Bearer token）：
- `/exec` 执行命令（cmd/powershell）、`/pi/run` 跑 Windows pi 子代理、`/file/read`、`/file/write`、`/ping`、`/health`、`/pi/abort`
- 开机自启（Startup 文件夹 PI2X-WinShell.vbs）
- 临时文件：Linux `<PI2X_ROOT>/tmp/`，Windows `<PI2X_ROOT_WIN>\tmp\`

## 命令前缀

- `$` 执行 Linux bash（仅 admin，cwd=workspace）
- `>` 执行 Windows cmd（仅 admin，经 win-agent）
- `/` 内置命令（help/status/memory/perms/whoami/op/deop/stop/restart/cred/strix/pi2x 等）
- 工具超时参数必须显式指定；无整体回复超时（/stop 或自然结束）

## 框架切换（strix ⇄ pi2x）

**仅 admin 私聊**可用（群聊硬拒绝，入口与路由两道判定）。切换是**按会话**的：
只影响触发者自己，其他用户照旧走 PI2X 主 agent。

| 命令 | 作用 |
|---|---|
| `/strix new <会话名> [目标...] [--mode quick\|standard\|deep] [--budget N] [--turns N] [--dir <目录>]` | 新建会话并接入（目标可省；预算/轮次默认不限） |
| `/strix ls [n]` | 列出历史会话（含状态/模式/花费/目标） |
| `/strix use <编号\|run名> [指令]` | 接回旧会话；给了指令就当新一轮注入 |
| `/strix status` | 当前是否接入、agent 状态、轮次、花费、子代理数 |
| `/strix report [run名]` / `findings` | 看报告 / 漏洞清单 |
| `/strix off` 或 `/pi2x` | 退回 PI2X 主框架 |

**第一个位置参数是「会话名」，不是扫描目标**。目标可以不给：`/strix new audit` 就是建一个
叫 `audit` 的会话，接进来说要扫什么即可。目标也不限于 URL —— 仓库、本地目录/文件、
OpenAPI/Swagger 规格、IP 都是合法目标（所以不做格式校验，交给 strix 自己判）。

**预算与轮次默认不限** —— strix 原生默认就是 `--max-budget=None`、`--max-turns=500`，
只有你显式给 `--budget/--turns` 才会传。别默认套限额：那是把一个自主会话变成
「跑到一半被掐断」。

**会话名随便起**（含中文）：strix 只吃 ASCII 且拿它当目录名，所以显示名与落盘名分离
（`slugOf` 转换 + `<run>/.label` 记显示名；`ls`/`use` 都认你起的名字）。

### 懒启动（重要）

`/strix new` / `/strix use` **不立即拉起进程**，只登记；**你说的第一句话才真正启动**，
那句话就是它的首轮任务指令。这不是取巧，是因为：

1. 只给名字时拉起 strix，agent 拿到的是空任务，不知道该干什么；
2. strix 自己会**拒绝恢复**「无目标、无指令」的会话（`run.json has no targets_info`）。

拿第一句话当任务，两个问题一起解。后续轮次直接说话就行。

### 实现要点

- **常驻会话，不是一轮一进程**：`strix/scripts/pi2x_worker.py` 把 strix 以
  `run_strix_scan(interactive=True)` 跑成长期进程，`coordinator.send()` 注入用户消息。
  strix 在 agent 调 `respond_to_user` 时 park 成 waiting，正好等于「交付答复并让出控制权」，
  所以多轮对话是它原生能力，不靠 `--resume` 重放历史。
- **正式答复从 `respond_to_user` 的工具参数取**，不在正文流里（正文只是干活时的叙述）→
  worker 分别标记 `kind=reply` / `kind=progress`。
- **worker 主动推 stdout**（`stdout_loop`），不是等 Node 侧 poll；
  且 Node 侧必须「看到过 running」才把 waiting 当本轮结束（否则首轮空手返回）。
- **不传 `-n`**：strix 的 `-n` 会强制要求 `-t`，而我们的 worker 是自己调
  `run_strix_scan()` 的，不需要它；不传才能走无目标会话。
- **会话名**：strix 没有 `--run-name` 参数，名字由 `prepare_run` 内部调
  `generate_run_name()` 生成。worker 通过替换该模块函数来接管命名（不能改 args 属性，
  因为那里不是从 args 读的）。重名会在命令层拦下 —— strix 的 run 目录就是会话名，
  重名会让「新建」变成「悄悄接续旧的」。
- **argv 分两段**：`[--name X] [--workspace Y] -- <strix 原生参数>`。
  早先多写了一个开头的 `--`，worker 把第一个 `--` 当成前置段结束符，
  `--name` 就被原样丢给 strix 的 argparse（报「参数不合法」）。
- **会话落盘**：`strix/runs/strix_runs/<run_name>/`。worker 的 cwd 与 spawn 的 cwd
  都必须是 `strix/runs`（strix 用 `cwd/strix_runs/<name>` 算目录）——
  cwd 不一致时 run 会落到两个不同目录，`/strix ls` 就看不到刚建的会话。
- **挂目录的限制**：strix 的沙箱只允许挂「它自己 cwd 之内」的路径
  （`base_dir = Path.cwd()`），挂外面的目录会在沙箱启动时报
  `failed to read local dir artifact`。所以无目标时默认**什么都不挂**；
  确实要挂目录就用 `--dir`，且路径需在 `strix/runs` 之内。
- **孤儿防护**：worker 收 SIGTERM/SIGHUP 即退；bridge 启动时 `sweepStrixOrphans()`
  清理 ppid=1 的残留 worker（kill -9/OOM 后不留白跑的 agent 与浏览器）。
- **启动失败要立即报**：worker 的 stderr 会被攒下并提纯（`extractStrixError`），
  进程早退即刻失败 —— 早先只会等满 120s 吐一句「启动超时」，
  真正的原因就静默躺在 stderr 里。
- **状态提示**：`private/state/strix-sessions.json` 记「某人上次用哪个会话」，
  仅用于重启后提示，**不自动接管**（防重启后自己接着扫生产环境）。

## 重启

- `/restart` 触发 `scripts/restart-pi2x.sh`：pkill 旧 bridge → 等待退出 → nohup 拉起 → 等 "pi agent 就绪" 后，用 `scripts/send-notify.mjs`（OneBot WebSocket）给触发者发上线提醒（✅ PI2X 已重启完成，服务已上线）
- bridge 重启不影响 NapCat（NapCat 由外部 screen 托管）
- 说明：OneBot 的 send_*_msg 走 WebSocket（`ws://host:port/?access_token=`），不能用 HTTP POST（会 Upgrade Required）

## 图片处理

QQ 图片经 `collectImages` 收集 → `{type:"image", data(base64), mimeType}`（SDK ImageContent）传给模型。仅支持 webp/png/jpeg/gif。

## 相关文档与调试

- 本项目权威说明：本文档 `PI2X.md`（当前实际实现）
- 项目介绍：`README.md`
- 运行日志：`logs/bridge.log`
- 会话历史：`sessions/*.jsonl`
- 提示词同步：`bash scripts/sync-prompt.sh`
- 重启：`bash scripts/restart-pi2x.sh`（重启 bridge，不动 NapCat）
