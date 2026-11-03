# strix-local —— 本地黑盒渗透引擎（无 Docker）

把 [strix](https://github.com/usestrix/strix)（开源自主 AI 渗透测试框架）改造成
**纯本机运行**，作为 PI2X 的一个可选执行引擎。

## 为什么需要它

strix 官方的沙箱是 `kalilinux/kali-rolling` 的 Docker 容器。本机是 Android 上的
Linux 容器（内核 `5.10.136-android12`），缺少 overlayfs/NAT 所需的内核能力，
**Docker 无法运行**。

strix 的沙箱后端虽然写死只有 `docker`，但 SD 底层（`agents` 包）自带
`UnixLocalSandboxSession` —— 支持 exec / PTY / 文件操作，直接跑在宿主机上。
于是我们：

1. 在 `strix/runtime/backends.py` 里新增 `local` 后端（复用 SDK 的本地沙箱）
2. 在 `interface/environment.py` 里让 `local` 后端跳过 Docker 前置检查
3. 在 `runtime/session_manager.py` 里让 `local` 后端跳过 Caido 容器代理引导
   （否则 `http_proxy` 会指向一个不存在的 sidecar，请求全部失败）

## 用法

```bash
# 需要先有 LLM 网关（默认复用 PI2X 自己的 omniroute）
export OMNIROUTE_BASE_URL=http://127.0.0.1:20128/v1
export OMNIROUTE_API_KEY=<网关 key>

strix/run.sh -n -t https://example.com --scan-mode quick --max-budget 2
```

## 工具链

本机模式跑在宿主机上，能用什么工具 = 宿主机装了什么。已按 strix 技能文档
（`tooling/*.md`）与官方 Kali 容器对照补齐，共 **32 项**：

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

### 故意未装的工具（爆破类）

ffuf · gobuster · dirb · dirsearch · hydra · hashcat · john

按需求**不装爆破工具**。注意：strix 的技能文档（`tooling/ffuf.md` 等）
仍会被加载进上下文（日志里的 `Loaded skill: tooling/ffuf`），但二进制不存在，
所以 agent 实际调不起来 —— 日志出现工具名不等于真的会执行。

### 浏览器说明

strix 的 `agent-browser`（动态分析 XSS/CSRF/认证流的关键能力）需要 Chrome：

- 二进制：`/root/.cache/ms-playwright/chromium-1243/chrome-linux-arm64/chrome`
- 环境变量由 `strix/scripts/agent-browser-env.sh` 设置，`run.sh` 自动 source
- 也可用 PI2X 自己的 9222 CDP 实例（`scripts/browser-cli.mjs`）

## 与官方版的差异

| 项 | 官方（Docker） | 本机（local） |
|---|---|---|
| 沙箱 | Kali 容器 | 宿主机 Unix 沙箱 |
| 工具链 | Kali 全套 | **32 项**（已对照补齐，见上） |
| HTTP 代理 | Caido sidecar | **无**（代理工具会明确报"不可用"） |
| 隔离性 | 强（容器） | 弱（同文件系统） |
| `--target ./dir` | 只读挂载 | 直接读宿主机目录 |

## 注意

- **只对授权目标使用**。本地模式没有容器隔离，且 agent 会真实发包。
- **爆破类工具未装**（按需求），目录/参数爆破能力缺失。
- 修改的是 venv 内的 strix 源码（`patches/strix-orig/` 存了原版备份）。
  pip 升级 strix 会覆盖改动 —— 重跑 `scripts/apply-patches.py` 即可恢复。
