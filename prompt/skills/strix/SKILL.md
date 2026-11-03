---
name: strix
description: 本地黑盒渗透测试引擎（strix，无需 Docker）。对网站/API/IP 做自主漏洞扫描：侦察 → 漏洞发现 → PoC 验证 → 出报告。需要扫描、渗透测试、安全评估、找漏洞时使用。经 bash 调用 scripts/strix-cli.mjs；若用户想「切到 strix 框架」多轮对话，用 /strix 命令（仅 admin 私聊）。
---

# strix —— 本地黑盒渗透引擎

把 [strix](https://github.com/usestrix/strix)（开源自主 AI 渗透测试框架，
XBOW 基准 96%）改造成**纯本机运行**（无 Docker），作为 PI2X 的一个可选执行器。

## 两种用法（先用第二种）

**① 框架切换（推荐，admin 私聊）**：`/strix new <会话名>` 建会话，第一句话就是它的任务，
之后像聊天一样多轮驱动。目标可以不给（`/strix new audit` 只建一个叫 audit 的会话）。
会话与历史都存在 strix 自己的 `agents.db`，`/strix ls` 能翻出以前的、`/strix use` 接回。
细节见 `PI2X.md` 的「框架切换」一节。**能多轮对话、能看到中间进度，比在下边跑 CLI 好用。**

**② 一次性 CLI**（本文以下内容）：不需要对话、只想取一份报告时用。

## 什么时候用

- 用户要求扫描/渗透测试/安全评估某个网站、API、IP
- 需要「有 PoC 验证过的漏洞报告」（而非静态扫描器的误报堆）
- 找 OWASP Top 10 类问题（认证绕过、越权、注入、XSS、SSRF）
- 自己写的服务上线前做一轮安全体检

**不要**用于：非授权目标（见下方红线）、纯源码审计（那用别的方式）。

## ⚠️ 红线（每次都先确认）

1. **授权**：必须是用户自己的资产，或用户明确说明已获授权。**绝不**对第三方站点随手扫。
2. **环境影响**：agent 会**真实发送 exploit payload**，可能创建/修改数据。
   优先测试环境；生产环境要显式告知用户风险。
3. **预算**：strix 真的花钱。**每次都设 `--budget`**（默认 2 美元）。
   漏设会一直跑到 `--turns` 上限（默认 60 轮）。
4. **隔离性弱**：本机模式无容器隔离（strix 官方用 Kali 容器，本机只能用宿主机沙箱）。

## 用法

```bash
# 环境自检（先跑这个）
node scripts/strix-cli.mjs status

# 列历史扫描
node scripts/strix-cli.mjs list 10

# 前台扫描（会阻塞很久，不建议直接在对话里跑）
node scripts/strix-cli.mjs scan https://target.example.com \
  --mode quick --budget 2 --turns 30

# 后台扫描（推荐：立即返回，稍后用 list/report 取结果）
node scripts/strix-cli.mjs start https://target.example.com \
  --mode quick --budget 2 --turns 30

# 看报告
node scripts/strix-cli.mjs report latest      # 完整 Markdown 报告
node scripts/strix-cli.mjs findings latest    # 漏洞清单
```

### 给 agent 的指令（强烈建议）

漏洞通常在登录之后。有测试账号就一定要给：

```bash
node scripts/strix-cli.mjs start https://staging.example.com \
  --mode standard --budget 5 \
  --instruction "测试账号 test@example.com / Passw0rd。范围: /app/*, /api/*。
                 不要动 /billing，不要发邮件。重点看两个组织之间的访问控制。"
```

- **两个账号胜过两个**：多租户越权（IDOR）只有能试跨账号访问时才能证明
- 说明**范围**和**禁区**（支付流程、批量发信、破坏性后台操作）

## 扫描模式

| 模式 | 用途 | 耗时 |
|---|---|---|
| `quick` | 快速摸底，高价值漏洞，广度优先 | 数分钟 |
| `standard` | 常规评审 | ~30 分钟 |
| `deep` | 发布前完整评估 | 数小时 |

## 本机工具链（已补齐 32 项）

| 分组 | 工具 |
|---|---|
| 端口与主机 | nmap · masscan · nc · ncat · netstat · ifconfig · ping · dig · whois |
| HTTP 探测 | curl · httpx · hurl · openssl · jq |
| 爬取 | katana |
| 漏洞扫描 | nuclei（含模板）· nikto · sqlmap |
| 指纹识别 | whatweb · wafw00f |
| 子域与资产 | subfinder · naabu |
| 二进制与取证 | file · xxd · gdb · strings · rg · ndiff |
| 脚本运行时 | python3 · node · perl · parallel |
| 浏览器 | agent-browser 0.26.0 + Chrome for Testing 153 |

自检：`python3 strix/scripts/toolcheck.py`

### ⚠ 爆破类工具故意未装

ffuf · gobuster · dirb · dirsearch · hydra · hashcat · john —— **按用户要求不装爆破工具**。

后果：**目录爆破、子域字典、密码喷洒能力缺失**。遇到需要这类手段的场景，
改用：
- 爬取（katana）+ 指纹（whatweb）+ 被动子域（subfinder）代替字典爆破
- 明确的端点列表（用户提供或从 JS/页面提取）代替暴力枚举

注意：strix 的技能文档（`tooling/ffuf.md` 等）**仍会被加载进上下文**，
但二进制不存在，agent 实际调不起来 —— **日志里出现工具名 ≠ 真的会执行**。

## 产出在哪

每次扫描在 `strix/runs/strix_runs/<runId>/` 下：

| 文件 | 内容 |
|---|---|
| `penetration_test_report.md` | 完整报告（执行摘要、方法论、技术分析） |
| `vulnerabilities/*.md` | 单个漏洞详情（含 PoC） |
| `vulnerabilities.json` | 结构化漏洞清单 |
| `findings.sarif` | SARIF 2.1.0（可接 CI/IDE） |
| `run.json` | 状态、token 用量、成本 |
| `strix.log` | 执行日志 |

## 判读结果的注意点

- **`--budget` 或 `--turns` 触顶会提前收尾** —— 报告里说「没漏洞」不代表安全，
  先看 `run.json` 的 `status` 和成本是否撞到上限。
- **报告里的 PoC 要自己复跑确认**再采信。
- 本机模式**工具链比官方容器薄**（官方容器带 Kali 全套 nmap/sqlmap/httpx 等），
  深层扫描（子域爆破、大字典）能力受限。要发挥全部实力得自行装工具。

## 架构说明（为什么是 CLI 不是子代理）

strix 自身已是多 agent 系统（root → 侦察 → 猎手 → 验证 → 报告），
**再套 PI2X 子代理会形成两层嵌套**，且它的「反轮询」设计（一次 wait、
同轮第二次 wait 立即返回、单响应工具调用数上限）会与我们的唤醒机制互相干扰。

所以它被包装成**普通 CLI 工具**（与 `browser-cli.mjs` 同一模式）：
派发 → 等它自己跑完 → 读产出。**不要**为它再套一层 `run_task`。

## 环境依赖

- Python venv: `strix/venv`（381MB，gitignore）
- 补丁: `strix/scripts/apply-patches.py`（pip 升级 strix 后需重跑）
- 工具链: 系统级安装（`/usr/local/bin` 等），自检 `strix/scripts/toolcheck.py`
- 浏览器: `strix/scripts/agent-browser-env.sh`（`run.sh` 自动 source）
- LLM: 复用 PI2X 自己的 omniroute 网关与模型（`openai/openai/deepseek-flash`）

### 与官方容器的主要差异

| 项 | 官方 | 本机 |
|---|---|---|
| 沙箱 | Kali 容器 | 宿主机 Unix 沙箱 |
| HTTP 代理 | Caido sidecar | **无**（代理工具会报"不可用"） |
| 隔离性 | 强 | 弱（同文件系统） |
| 爆破工具 | 有 ffuf | **故意不装** |
