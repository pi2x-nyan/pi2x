---
name: browser
description: 无头浏览器自动化（headless Chrome/CDP）：导航、点击、输入、取页面数据、截图。经 bash 调用 <PI2X_ROOT>/scripts/browser-cli.mjs；管理员用 9222，其他用户一律用 9223 隔离实例（无 admin 凭据）；任务完成必须 close 标签页。网页动态渲染/需交互/需登录时使用。
---
# browser —— 浏览器自动化

用无头 Chromium（headless Chrome，CDP）访问网页、交互、取数据、截图。

## 何时使用
- 网页内容动态渲染（fetch/curl 抓不到，需 JS 执行）
- 需要登录/点击/填表/翻页的网页操作
- 查看页面结构（CSS 选择器定位元素）
- 截图留证

## 端口约定（用户隔离，凭据隔离）
- **9222 = 管理员实例**：profile `browser-profile`，保留 admin 登录态（cookie）
- **9223 = 普通用户/operator 实例**：profile `browser-profile-op`，全新环境、**不含 admin 任何 cookie/凭据/登录态**
- 当前对话者是谁就选哪个端口：**admin → 9222；其他任何用户 → 必须 9223**
- **禁止**：在 9223 实例登录/输入 admin 账号密码或使用 admin 凭据；不要把 admin 的 cookie/凭据带到非 admin 会话

## 用法（通过 bash 执行）
```bash
B="node <PI2X_ROOT>/scripts/browser-cli.mjs"
$B --port 9223 status                     # 检查（operator/普通用户用 9223）
$B --port 9223 navigate "https://..."     # 打开网页（返回标题+文本）
$B --port 9223 read                       # 当前页 url/标题/正文
$B --port 9223 click "button.primary"     # 点击（CSS 选择器）
$B --port 9223 type "#username" "账号"     # 输入（React 兼容）
$B --port 9223 js "document.title"        # 任意 JS（拿数据）
$B --port 9223 screenshot                 # 截图（<PI2X_ROOT>/tmp/）
$B --port 9223 close                      # 关闭当前标签页
```
> 浏览器未运行时 CLI 会自动拉起对应端口的实例（同一端口即同一隔离环境，登录态延续）。

## 工作流建议
1. 确认端口（当前用户决定），`status` 看是否就绪
2. `navigate <url>` → 看标题/正文判断页面是否正确
3. 需要交互 → `read` 看结构 → `js` 检查元素是否存在
4. 填表/点击/翻页 → `type` / `click`；异步加载后 `sleep 1` 再 `read` 验证
5. 拿页面数据 → `js` 返回 JSON

## 任务完成后
- **执行 `close` 关闭标签页**（保持干净；全关自动开 blank 兜底）

## 注意
- CSS 选择器精确：id（`#x`）、类（`.x`）、属性（`input[name=...]`）
- 弹窗/iframe：`js` 里用 `document.querySelector` / `iframe.contentDocument`
- 登录凭据：从 get_credential 取，**不在对话回显密码**
- **绝不在非 admin 会话使用 admin 凭据/登录 admin 账号（凭据隔离要求）**
- 沙箱（bwrap）已开放网络：operator 可正常搜索/访问网页；但 bash 环境系统仍只读，仅沙盒与 shared 可写
- 操作失败先看错误原样返回，别编造成功