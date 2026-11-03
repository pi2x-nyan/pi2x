---
name: computer-use
description: 真实桌面操作（X11/Xvfb）：截图、按坐标点击、拖拽、滚轮、键盘输入、窗口管理。底层是 @agent-sh/computer-use-linux（AT-SPI + xdotool），仅管理员可用；用于无头浏览器（browser 技能）覆盖不到的普通桌面程序场景。
---
# computer-use —— 桌面操作

操作一台「虚拟桌面」里的真实 GUI 程序：截图、点、拖、滚、打字、按键、切窗口。
底层用 `@agent-sh/computer-use-linux@0.7.36`（全局安装，`/usr/local/bin/computer-use-linux`），不是我们自己写的。

## 什么时候用

- 要操作的不是网页，而是普通桌面程序（Electron、Qt、GTK、模拟器界面）
- 网页里点不到的元素（跨 iframe 的原生控件、文件选择框、系统弹窗）
- 需要「看屏幕」确认别的东西画成什么样

只是抓网页数据、点网页按钮，用 `browser` 技能（CDP）更快更稳，别用这个。

## 前置：必须有虚拟显示

```bash
# 起一个 1280x800 的虚拟屏（没有窗口管理器时窗口列表会报 backend unavailable）
Xvfb :99 -screen 0 1280x800x24 & 
DISPLAY=:99 openbox &          # 可选，但 list_windows 依赖 EWMH
export DISPLAY=:99
export XDG_SESSION_TYPE=x11    # ★ 必须，见下面的坑
```

## 两种调用方式

**只读类（CLI 直接调）**

```bash
computer-use-linux doctor                    # 自检：X11/AT-SPI/后端是否就绪
computer-use-linux screenshot --output <PI2X_ROOT>/tmp/x.png
computer-use-linux windows
computer-use-linux apps
```

**输入类（走 MCP）** —— 点击、拖拽、滚轮、键盘只能通过 MCP 工具调：

```bash
node <PI2X_ROOT>/scripts/mcp-call.mjs list                       # 看有哪些工具
node <PI2X_ROOT>/scripts/mcp-call.mjs call click '{"x":640,"y":400}'
node <PI2X_ROOT>/scripts/mcp-call.mjs call press_key '{"key":"ctrl+l"}'
node <PI2X_ROOT>/scripts/mcp-call.mjs call scroll '{"x":640,"y":400,"direction":"down","amount":3}'
node <PI2X_ROOT>/scripts/mcp-call.mjs call screenshot '{}' --save-image <PI2X_ROOT>/tmp/x.png
```

可用工具：activate_window / click / drag / focused_window / list_windows / list_apps /
move_window / press_key / resize_window / scroll / screenshot / set_value / perform_action / get_app_state

## 坑（踩过，别再踩）

1. **`XDG_SESSION_TYPE=x11` 不设，点击会假成功**：它走 uinput 绝对指针，Xvfb 里什么都点不到，但返回 `ok:true`。看到"点了没反应"先查这个环境变量。
2. **裸 Xvfb 没有窗口管理器**：`list_windows` 会 `backend unavailable`，需要 openbox（已装）。
3. **AT-SPI 起不来**：`get_app_state` / `perform_action` / 元素级操作在这台机器上都用不了，只能按坐标点。坐标从截图上量，先 shot 再算像素。
4. 截图默认存 `<PI2X_ROOT>/tmp/`，别丢到工作区。

## 收尾

任务结束把起的 Xvfb / openbox / 程序停掉，别在后台留进程。
