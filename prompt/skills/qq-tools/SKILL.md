---
name: qq-tools
description: QQ 能力手册。核心对话工具（qq_send_message/qq_send_file）始终可用；查询/管理类非核心能力不注入工具清单，经 <PI2X_ROOT>/scripts/qq-cli.mjs 渐进披露（group_history/msg_detail/friend_list/group_list/ocr/group_file_url/download/delete_msg/napcat/op/deop），需要时先读本 skill 再按需调用（--as 当前用户QQ）。
---
# qq-tools —— QQ 能力（渐进披露）

本 skill 说明 PI2X 的 QQ 能力。**核心对话工具（发消息/发文件）始终可用；其余（查询/管理/文件等）不注入工具清单，需要时按下方用 bash 调用脚本**——避免每轮请求都携带全部工具、节省上下文。

## 始终可用的核心对话工具（pi 工具）
- `qq_send_message`：主动发消息（**默认不用来回复当前对话**：正文会自动发出，再调它就重复两遍；只在发给别的会话或单独推送进度时用）
- `qq_send_file`：发文件（非 admin 仅沙盒/shared 内路径）

## 按需调用（bash + CLI，渐进披露）
需要以下能力时，**先确认当前对话者身份（决定 `--as` 与权限）**，再执行：
```bash
Q="node <PI2X_ROOT>/scripts/qq-cli.mjs --as <当前用户QQ>"
$Q group_history <群号> [条数]        # 群最近聊天记录（所有人可用；非特权只能查当前群）
$Q msg_detail <消息id>                 # 单条消息详情
$Q friend_list / group_list           # 好友/群列表
$Q ocr <图片本地路径>                   # 图片文字识别
$Q group_file_url <群号> <file_id> <busid>  # 取群文件下载链接
$Q download <url> [超时秒]             # 下载到本地（workspace）
$Q delete_msg <消息id>                 # 撤回消息
$Q napcat <action> <json参数>          # 直调 OneBot API（高风险接口需确认）
$Q op <目标QQ> <friend|operator|admin> # 授权
$Q deop <目标QQ>                        # 撤销授权
```

## 权限与规则
- 脚本会按 `--as` 用户自动校验对应权限 token；不足会返回"权限不足：需要「X」"——**如实转告，不要绕过**
- **`group_history` 对所有权限组开放**，但非特权用户只能查**自己当前所在的群**（最近 30 分钟内说过话的那个）：
  - 在群里问「刚才谁说了什么」→ 直接 `$Q group_history <当前群号>`，正常返回
  - 想查别的群 → 会被拒绝（"只能查当前群"）。这是隐私边界，不要试图换写法绕过，也不要把这条限制包装成技术故障
  - 报「没记录到你最近在哪个群说过话」时，如实告诉对方：先在那个群里说一句，再来查
- `napcat`/`op`/`deop` 仅管理类用户；`delete_msg`/`download` 需对应 token
- **核心对话权限**：friend 及以上有 `qq_send_message`/`qq_send_file`
- 需要时先 `friend_list`/`group_list` 找目标 QQ/群，再组合后续操作

## 常见组合
- "刚才群里说了X？" → `group_history` → 概括
- "这张图写了什么" → 看文件路径 → `ocr`
- "把 XX 发我" → `download`/web 抓取 → `qq_send_file`
- "查/给某人权限" → `friend_list`/`group_list` → `op`/`deop`

## 失败披露
返回真实错误（HTTP/状态/权限原文），一次最多重试 1~2 次，失败如实说明。
