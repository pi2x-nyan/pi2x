# PI2X — QQ 智能助手（NapCat + pi）

以 **pi（@earendil-works/pi-coding-agent）为 agent 框架**的 QQ Chatbot。
NapCat 提供 QQ/OneBot11 通道，pi SDK 以**完全隔离的环境**驱动 agent。

```
QQ 用户 ⇄ NapCat (项目内, OneBot11 WS) ⇄ PI2X Bridge ⇄ pi AgentSession
                      ws://127.0.0.1:3001           (SDK 会话 + 专属 skills/工具)
```

## 目录结构

```
PI2X/
├── bridge.mjs              # 主入口（启动/路由/回复）
├── bridge-safe.mjs         # 安全模式入口（三级降级链的中间层）
├── config.example.json     # 配置示例（复制为 config.json 后按需修改）
├── package.json
├── PI2X.md                 # 架构与运维说明
├── lib/
│   ├── config.mjs          # 配置与路径的**唯一**数据源（默认值集中、容错读取、原子写）
│   ├── log.mjs             # 结构化日志（级别 / 轮次 ID / 耗时 / JSON 通道）
│   ├── text.mjs            # 纯函数（余弦相似度、工具调用泄漏检测）
│   ├── model-config.mjs    # provider 注册与模型解析（正常/安全模式共用）
│   ├── piagent.mjs         # pi AgentSession 管理（隔离环境 + 专属工具）
│   ├── qqbridge.mjs        # OneBot11 WebSocket 客户端（事件/API/自动重连）
│   ├── napcat.mjs          # NapCat 生命周期（配置同步、启动/停止/健康检查）
│   ├── napcat-api.mjs      # NapCat 扩展接口（渐进披露能力的底层）
│   ├── memory.mjs          # 记忆子系统（检索 / 存储 / 反思）
│   ├── memory-source.mjs   # 记忆来源键（私聊 vs 群聊的隔离口径）
│   ├── sessions-maint.mjs  # 会话文件瘦身 / 归档 / 孤儿清扫
│   ├── reminders.mjs       # 定时提醒存储
│   ├── credentials.mjs     # 凭据加密存储
│   ├── winhost.mjs         # win-agent 寻址与自动回退
│   ├── op-policy.mjs       # 权限授予/回收策略（防越权提级）
│   ├── whitelist.mjs       # 权限白名单
│   ├── risk-review.mjs     # 非管理员请求的风险评审
│   ├── turn-context.mjs    # 轮次上下文（AsyncLocalStorage，防并发串会话）
│   ├── mode.mjs            # 运行模式与心跳（正常 / 安全 / 回滚）
│   ├── lifecycle.mjs       # 自愈生命周期（三级降级编排）
│   ├── ccusage.mjs         # Command Code 号池用量与缓存命中率
│   ├── prompts.mjs         # 提示词加载与模板渲染
│   ├── tools/              # 工具定义，按域拆分 + 声明式注册表
│   │   ├── index.mjs       #   ORDER 顺序表 + TOOL_PERM 权限门禁
│   │   └── memory/reminders/session/windows/subagent/credentials/messaging.mjs
│   ├── agent/              # 对话装配（每轮请求怎么拼、怎么发、怎么收）
│   │   ├── turn-assembler.mjs   # 并发提交与回复组装
│   │   ├── stream-flusher.mjs   # 增量流式发送
│   │   ├── compact-policy.mjs   # 自动压缩判定与上下文占用展示（纯函数）
│   │   ├── settings.mjs         # pi 会话设置单一来源（压缩预算等）
│   │   ├── chat-key.mjs         # 会话键与上下文行选择
│   │   └── sent-log.mjs         # 「本轮已由工具发送」滚动日志
│   └── safe/               # 安全模式（依赖闭包受测试锁定）
│       ├── sentry.mjs           # 最小可运行 agent
│       └── giveup.mjs           # 放弃并触发回滚
├── prompt/                 # 提示词（改这里就能改行为，不必动代码）
│   ├── agent/system.md          # 主 agent 系统提示词
│   ├── context/session.md       # 会话上下文模板（谁·何时·说了什么）
│   ├── skills/                  # 技能手册（按需 read 全文）
│   ├── tools/*.md               # 各工具的描述（label + description）
│   ├── memory/                  # 记忆收割 / 反思提示词
│   ├── reviewer/ · risk/        # 风险评审提示词
│   └── context/2x.md            # 人格设定（本地私有，公开版自动剥离）
├── scripts/                # 运维与工具脚本（34 个）
│   ├── preflight.mjs            # 冒烟检查（语法 + import + 配置 + 测试门禁）
│   ├── restart-pi2x.sh          # 带保险的重启（先检查后杀进程）
│   ├── watchdog.mjs             # 看门狗（心跳失联自动拉起 / 降级）
│   ├── mode.mjs · rollback.mjs  # 模式切换与回滚
│   ├── sessions-maint.mjs       # 会话瘦身 / 归档
│   ├── scan-secrets.mjs         # 敏感信息扫描（推送前门禁）
│   ├── export-public.mjs        # 导出公开版（剥离人设与隐私）
│   ├── qq-cli.mjs               # QQ 查询/管理能力（渐进披露）
│   ├── browser-cli.mjs          # 无头浏览器
│   ├── memory-cli.mjs           # 记忆运维（校准 / 探针 / 反思）
│   └── cc-usage.mjs             # 号池用量查询
├── test/                   # 回归测试（269 例，npm test 约 12 秒）
├── win-agent/              # Windows 侧远程执行代理
├── napcat/napcat/config/   # NapCat 配置（本体不入库，按官方方式安装）
├── agent-dir/              # pi 独立 agent 目录（隔离，不碰 ~/.pi/agent）
├── workspace/              # agent 工作目录（文件操作、记忆存储）
└── sessions/               # 每个 QQ 会话一个 jsonl（chatKey 命名，显式路径）
```

> 运行期目录（`config.json`、`sessions/`、`workspace/`、`logs/`、`state/`、
> `agent-dir/`、`napcat/`）都在 `.gitignore` 里，公开仓库不含任何真实数据。

## 环境隔离设计（不污染其他 pi agent）

| 项目 | 策略 |
|------|------|
| 全局扩展/skills/prompts | `noExtensions/noSkills/noPromptTemplates/noThemes/noContextFiles` 全部关闭 |
| bot 自己的 skills | `additionalSkillPaths` 只加载 `prompt/skills/`（及 `scripts/*/SKILL.md`）下的技能手册 |
| agent 配置目录 | 独立 `agent-dir/`，不读写 `~/.pi/agent` 的设置/sessions |
| 会话文件 | 显式路径 `sessions/{chatKey}.jsonl`，不写入全局 sessions |
| bot 专属工具 | `customTools`（仅本会话可见）：`remember_user`、`read_user_memories`、`qq_send_message` |
| 工作目录 | 独立的 `workspace/`（agent 的 bash/read 等工具都在此运行） |

## 快速开始

```bash
node bridge.mjs
```

启动流程：
1. 自动同步 OneBot11 配置（端口 3001 / token 与 config.json 一致）
2. 拉起项目内 NapCat；**首次需要扫码登录 QQ**（二维码见 `napcat/napcat/cache/qrcode.png`，或打开 NapCat WebUI —— 地址与 token 见启动日志，也可在 `webui.json` 中查看）
3. 登录后即自动连接，QQ 群里 @bot 或私聊即可对话

## 配置说明（config.json）

| 字段 | 说明 |
|------|------|
| `napcat.qqAccount` | QQ 账号（对应 onebot11_{账号}.json） |
| `napcat.onebot.*` | OneBot11 WS 服务器地址/端口/token |
| `pi.workspace/agentDir` | agent 工作与配置目录 |
| `pi.replyTimeoutMs` | 单轮回复超时（默认 180s） |
| `pi.maxReplyChars` | 单条 QQ 消息最大字符（默认 1500，超长自动分段） |
| `permissions.allowedUsers/Groups` | 空 = 不限制；填入后仅白名单可用 |
| `permissions.groupReplyMode` | `mention`（仅 @ 回复，默认）/ `all`（群里全回复） |

## 常用命令

```bash
npm start              # 启动 PI2X
# Ctrl+C 优雅退出（自动关闭 NapCat 子进程树）
```

## 备注

- NapCat 版本：9.9.27-45627（QQNT），WebUI token 见启动日志（本仓库不记录任何真实 token）
- pi SDK：0.84.4，模型复用本机已配置的凭据（zai / opencode-go / deepseek）