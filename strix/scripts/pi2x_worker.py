#!/usr/bin/env python3
"""strix 常驻会话 worker —— 给 PI2X 当「框架后端」用。

【这是什么】
把 strix（自主渗透引擎）跑成**一个常驻进程 + 一个多轮会话**，通过 stdin/stdout
的 JSON Lines 跟 PI2X 通话。不是一轮一个 CLI 进程，而是一次拉起、反复对话：

    PI2X（Node）  ──JSON 行──▶  worker（本文件，常驻）
                                  └─ run_strix_scan(interactive=True) 一直在跑
                                     coordinator.send() 注入用户消息 → 多轮

【为什么这么做】
strix 自带 `respond_to_user` / `finish_scan` 的生命周期工具：agent 一调用
`respond_to_user` 就 park 成 waiting，等用户回话；`coordinator.send()` 唤醒它、
把消息当作新的用户输入续跑。所以**不需要**每轮重启进程、也不需要靠
`--resume` 重新加载历史 —— 直接在同一个进程里接着聊。会话历史本来就在
strix 自己的 agents.db 里，常驻进程内存里也有完整状态。

只有三种情况走 `--resume` 式重启：
  · 进程崩了 / 被杀了 → 重启时用已有 run_name 恢复
  · 用户要「继续以前的会话」→ 用那个 run_name 拉起
  · 用户要「新建会话」→ 换一个新 run_name

【协议】（每行一个 JSON 对象）
  PI2X → worker：
    {"op":"poll"}                        取积压的输出（非阻塞，立即返回）
    {"op":"send","text":"..."}           给 root agent 发一条用户消息
    {"op":"status"}                      取状态快照
    {"op":"quit"}                        正常收尾退出
  worker → PI2X：
    {"type":"ready","run_name":"...","root_id":"..."}
    {"type":"say","seq":N,"text":"...","final":bool}   agent 的可见输出
    {"type":"status","state":"...","root_status":"...","cost":..,"turns":..}
    {"type":"error","message":"..."}
    {"type":"bye"}

【注意】
· strix 的 `finish_scan` 只结束「本次扫描任务」，进程照常活着 —— 之后还能
  继续 send，等于「这个会话里又能派新活了」，正是我们要的多轮。
· 输出只取 root agent 的**用户可见文本**（与 strix TUI 的 live_view 同源），
  工具调用/内部推理不往 QQ 上灌。
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import signal
import sys
import time
import traceback
from pathlib import Path


def _log(msg: str) -> None:
    """诊断日志走 stderr（stdout 是协议信道，绝不能污染）。"""
    print(f"[strix-worker] {msg}", file=sys.stderr, flush=True)


def _emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


class Worker:
    def __init__(self, argv: list[str], *, session_name: str | None = None, workspace: str | None = None) -> None:
        self.argv = argv
        # 用户指定的会话名（None = 让 strix 自己命名）
        self.session_name = session_name
        # 无目标会话时挂进去给 agent 干活的工作目录
        self.workspace = workspace
        self.queue: list[dict] = []
        self.seq = 0
        self.run_name: str | None = None
        self.root_id: str | None = None
        self.coordinator = None
        self.scan_task: asyncio.Task | None = None
        self.events_by_agent: dict[str, int] = {}
        self.user_gate = asyncio.Event()      # poll 时用来等新输出
        self.stopping = False
        self._last_cost = 0.0
        self._turn_count = 0
        self._finished_count = 0

    # ---------- 协议 ----------

    def say(self, text: str, *, final: bool = True, kind: str = "progress") -> None:
        """kind: reply = agent 的正式答复；progress = 干活时的叙述。"""
        text = (text or "").strip()
        if not text:
            return
        self.seq += 1
        self.queue.append(
            {"type": "say", "seq": self.seq, "text": text, "final": final, "kind": kind}
        )
        self.user_gate.set()

    def notify(self, obj: dict) -> None:
        self.queue.append(obj)
        self.user_gate.set()

    def drain(self) -> list[dict]:
        out = self.queue[:]
        self.queue.clear()
        return out

    # ---------- 与 strix 对接 ----------

    async def boot(self) -> None:
        from strix.config import load_settings
        from strix.core.agents import AgentCoordinator
        from strix.core.runner import run_strix_scan
        from strix.interface.cli_args import parse_arguments
        from strix.interface import scan_setup
        from strix.interface.utils import read_workspace_files
        from strix.report.state import ReportState, set_global_report_state

        # 会话名由调用方指定（`--` 后除第一个参数外的特殊形式，见 main()），
        # 用于把 strix 自带的「目标标签+随机后缀」命名换成用户想要的名字。
        want_name = self.session_name

        # strix 的 CLI 解析器吃的是 sys.argv；我们在启动时就把它替成待执行的参数
        saved = sys.argv
        sys.argv = ["strix", *self.argv]
        try:
            args = parse_arguments()
        except SystemExit as exc:
            # parse_arguments 对非法/缺失参数会直接 sys.exit —— 在常驻进程里那是灾难。
            # 转成普通异常，让上层把原因回给用户（否则只有一个「启动超时」）。
            raise RuntimeError(
                "strix 参数不合法（目标格式或选项有误，见上方 usage 的 error 行）"
            ) from exc
        finally:
            sys.argv = saved

        # 交互模式：agent 用完 respond_to_user 会 park 等用户，正是多轮所需
        args.non_interactive = False

        # 【无目标会话】strix 的 `-n` 模式强制要 -t，但它的交互式 setup 流程是支持
        # 「没有目标、只有一句话」的：把用户的工作目录挂进去当 workspace（注意：
        # workspace 不是扫描目标，不进 targets_info，也就不带授权范围），指令本身
        # 就是全部输入。我们要的「只建一个会话名、不指定扫什么」正是这种。
        if not args.targets_info and not args.resume:
            args.needs_setup = False
            # 【挂 workspace 的约束（实测）】strix 的沙箱只允许挂「它自己 cwd 之内」
            # 的路径（base_dir = Path.cwd()），挂外面的目录会在沙箱启动阶段直接报
            # “failed to read local dir artifact”。而 worker 的 cwd 必须是
            # strix/runs（否则 run 目录会落到别处），于是：
            #   · 用户明确给了 --dir（形如 strix/runs 之内的路径）→ 挂它
            #   · 没给 → **什么都不挂**，只靠对话驱动（没有目标也可以说话）
            # 硬挂一个 strix/runs 之外的目录只会让会话建不起来。
            mount = self.workspace or ""
            if mount and Path(mount).is_dir():
                base = Path.cwd().resolve()
                try:
                    Path(mount).resolve().relative_to(base)
                    args.workspace_mount = mount
                except ValueError:
                    _log(f"workspace 在沙箱允许范围之外，跳过挂载：{mount}（需位于 {base} 之内）")
            else:
                _log("无目标会话：不挂 workspace")

        # 【自定义会话名】strix 只有 -t 才会自动命名，且带随机后缀。默认用它的
        # 命名；调用方指定了名字就覆盖 —— 用 replace 而不是改属性，因为
        # prepare_run 内部直接调模块级函数（args 上没有名字字段）。
        if want_name:
            if args.resume:
                # 恢复时名字必须是已存在的 run，不能另起
                args.resume = want_name
            scan_setup.generate_run_name = lambda *_a, **_k: want_name

        scan_setup.prepare_run(args)
        scan_setup.telemetry_start(args)
        self.run_name = args.run_name
        # 会话名字：自定义时直接用；否则记录 strix 自动生成的那个
        _log(f"session name = {self.run_name}")

        scan_config = {
            "scan_id": args.run_name,
            "targets": args.targets_info,
            "user_instructions": args.instruction or "",
            "run_name": args.run_name,
            "diff_scope": args.diff_scope,
            "scan_mode": args.scan_mode,
            "non_interactive": False,
            "local_sources": args.local_sources or [],
            "workspace_files": getattr(args, "workspace_files", None) or [],
            "scope_mode": args.scope_mode,
            "diff_base": args.diff_base,
            # 恢复时把这次的 --instruction 当新一轮用户消息注入（strix 原生语义）
            "resume_instruction": args.user_explicit_instruction or "",
            "workspace_mount": getattr(args, "workspace_mount", None) or "",
            "workspace_subdir": getattr(args, "workspace_subdir", None) or "",
        }

        self.coordinator = AgentCoordinator()
        report_state = ReportState(args.run_name)
        report_state.hydrate_from_run_dir()
        report_state.set_scan_config(scan_config)
        report_state.save_run_data()
        set_global_report_state(report_state)

        self.scan_task = asyncio.create_task(
            run_strix_scan(
                scan_config=scan_config,
                scan_id=args.run_name,
                image=str(load_settings().runtime.image or "strix-sandbox:latest"),
                local_sources=args.local_sources or [],
                extra_files=read_workspace_files(getattr(args, "workspace_files", None)),
                coordinator=self.coordinator,
                interactive=True,
                max_turns=args.max_turns,
                max_budget_usd=args.max_budget_usd,
                event_sink=self.on_event,
            )
        )

        self.root_id = await self.wait_root()
        _log(f"booted run={self.run_name} root={self.root_id}")
        _emit({"type": "ready", "run_name": self.run_name, "root_id": self.root_id})

    async def wait_root(self, timeout: float = 180.0) -> str | None:
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            if self.scan_task is not None and self.scan_task.done():
                exc = self.scan_task.exception()
                if exc:
                    raise exc
                return None
            if self.coordinator is not None:
                async with self.coordinator._lock:
                    for aid, name in self.coordinator.names.items():
                        if name == "Root Agent":
                            return aid
            await asyncio.sleep(0.5)
        return None

    def on_event(self, agent_id, event) -> None:
        """把 strix 的 SDK 事件流里的**用户可见文本**捞出来。

        两条通道，对应 strix 自己的设计：
          · raw_response_event / response.output_text.delta
              → 流式正文，agent 干活时的叙述（进度性质）
          · run_item_stream_event / tool_call_item，且工具是 respond_to_user
              → **正式答复**。strix 的约定是「交付答复与让出控制权是同一个动作」，
                所以用户真正要读的那句话在这里的参数里，不在正文流里。
                漏掉它，QQ 上就只剩 agent 的碎碎念。

        工具调用细节、推理摘要、子代理事件一律不往 QQ 送（否则是一屏日志）。
        子代理的输出也不送：只有 root 在跟人说话。
        """
        try:
            if agent_id != self.root_id or self.root_id is None:
                return
            etype = getattr(event, "type", "")

            if etype == "run_item_stream_event":
                item = getattr(event, "item", None)
                if getattr(item, "type", "") != "tool_call_item":
                    return
                raw = getattr(item, "raw_item", None)
                name = str(getattr(raw, "name", "") or "")
                if name not in {"respond_to_user", "respond"}:
                    return
                args_raw = getattr(raw, "arguments", None)
                try:
                    parsed = json.loads(args_raw) if isinstance(args_raw, str) else (args_raw or {})
                except Exception:
                    parsed = {}
                msg = ""
                if isinstance(parsed, dict):
                    msg = str(parsed.get("message") or "")
                if msg.strip():
                    # 正式答复单独成一条，并且把它前面攒的叙述先冲出去，保持顺序
                    self.flush_pending()
                    self.say(msg, final=True, kind="reply")
                return

            if etype != "raw_response_event":
                return
            data = getattr(event, "data", None)
            if getattr(data, "type", "") != "response.output_text.delta":
                return
            delta = getattr(data, "delta", "")
            if not delta:
                return
            # 流式分片累积；等这段输出「静默」后再整体吐出（见 flush_loop）
            self._pending = getattr(self, "_pending", "") + str(delta)
            self._pending_at = time.monotonic()
        except Exception:
            _log("on_event failed: " + traceback.format_exc(limit=2))

    def flush_pending(self) -> None:
        """把攒着的叙述文本立刻吐出去（保持与正式答复的先后顺序）。"""
        buf = getattr(self, "_pending", "")
        self._pending = ""
        self._pending_mark = None
        text = self.strip_internal(buf)
        if text:
            self.say(text, kind="progress")

    async def flush_loop(self) -> None:
        """把累积的流式文本按「静默 2 秒」为界，成段吐给 PI2X。"""
        while not self.stopping:
            await asyncio.sleep(0.5)
            buf = getattr(self, "_pending", "")
            if not buf:
                continue
            last = getattr(self, "_pending_at", 0.0)
            if time.monotonic() - last < 2.0:
                continue
            self.flush_pending()

    @staticmethod
    def strip_internal(text: str) -> str:
        """去掉 strix 输出里不该发给用户的内部包装。

        root agent 有时把给用户的答复包在 `respond_to_user(message="...")` 这类
        调用字面量里（工具未真正执行时）。尽量还原可读正文；还原不出就原样返回。
        """
        t = text.strip()
        if not t:
            return ""
        for marker in ('respond_to_user(', 'respond(', 'message="'):
            if t.startswith(marker):
                inner = t[len(marker):]
                inner = inner.rstrip(")")
                inner = inner.strip().strip('"').strip("'")
                if inner:
                    return inner
        return t

    async def op_send(self, text: str) -> dict:
        if self.coordinator is None or self.root_id is None:
            return {"type": "error", "message": "会话尚未就绪"}
        ok = await self.coordinator.send(
            self.root_id,
            {"from": "user", "type": "instruction", "content": text},
        )
        self._turn_count += 1
        return {"type": "sent", "ok": bool(ok), "turn": self._turn_count}

    async def op_status(self) -> dict:
        status = None
        agents = {}
        if self.coordinator is not None:
            async with self.coordinator._lock:
                status = self.coordinator.statuses.get(self.root_id)
                agents = {
                    aid: {"name": n, "status": self.coordinator.statuses.get(aid)}
                    for aid, n in self.coordinator.names.items()
                }
        cost = 0.0
        try:
            from strix.report.state import get_global_report_state

            rs = get_global_report_state()
            if rs is not None:
                usage = (rs.run_record or {}).get("llm_usage") or {}
                cost = float(usage.get("cost") or 0.0)
        except Exception:
            pass
        self._last_cost = cost
        return {
            "type": "status",
            "run_name": self.run_name,
            "root_id": self.root_id,
            "root_status": status,
            "agents": agents,
            "cost_usd": cost,
            "turns": self._turn_count,
            "scan_done": bool(self.scan_task and self.scan_task.done()),
        }

    async def stdout_loop(self) -> None:
        """**主动**把积压输出推给 PI2X。

        【为什么必须有这个循环】第一版只有「收 poll 才回话」：PI2X 发完 send
        就开始等，而 worker 只会在收到下一个请求时才吐出之前攒的输出 ——
        两边都等对方，结果扫描早跑完了、报告都写盘了，QQ 上一个字都没收到。
        改成 worker 自己扫到东西就推，PI2X 只需读 stdout。
        """
        while not self.stopping:
            await asyncio.sleep(0.4)
            items = self.drain()
            if items:
                _emit({"type": "batch", "items": items})

    async def stdin_loop(self) -> None:
        loop = asyncio.get_running_loop()
        while not self.stopping:
            line = await loop.run_in_executor(None, sys.stdin.readline)
            if not line:            # EOF：PI2X 走了
                self.stopping = True
                break
            line = line.strip()
            if not line:
                continue
            try:
                req = json.loads(line)
            except Exception:
                _emit({"type": "error", "message": "非法 JSON"})
                continue
            op = req.get("op")
            try:
                if op == "poll":
                    # 输出由 stdout_loop 主动推；poll 只做一次确认回应
                    _emit({"type": "pong"})
                elif op == "send":
                    res = await self.op_send(str(req.get("text") or ""))
                    _emit(res)
                elif op == "status":
                    _emit(await self.op_status())
                elif op == "quit":
                    self.stopping = True
                    break
                else:
                    _emit({"type": "error", "message": f"未知 op: {op}"})
            except Exception as exc:
                _emit({"type": "error", "message": f"{op} 失败: {exc}"})
                _log(traceback.format_exc(limit=4))

    async def run(self) -> None:
        try:
            await self.boot()
        except Exception as exc:
            _emit({"type": "error", "message": f"启动失败: {exc}"})
            _log(traceback.format_exc())
            return
        flush = asyncio.create_task(self.flush_loop())
        out = asyncio.create_task(self.stdout_loop())
        try:
            await self.stdin_loop()
        finally:
            self.stopping = True
            flush.cancel()
            out.cancel()
            # 收尾：把还挂着的扫描任务停掉，别留孤儿 agent
            if self.scan_task is not None and not self.scan_task.done():
                self.scan_task.cancel()
                try:
                    await self.scan_task
                except BaseException:
                    pass
            try:
                from strix.runtime import session_manager

                if self.run_name:
                    await session_manager.cleanup(self.run_name)
            except Exception:
                pass
            _emit({"type": "bye"})
            # 【为什么要硬退】strix 与 SDK 内部启了不少子进程/管道，asyncio 被拆掉时
            # 它们的析构器会抱怨「Event loop is closed」，一整页 traceback 在 bridge
            # 日志里刷屏（实测），把真正的错误埋掉。收尾已经做完了，直接 _exit 最干净。
            sys.stderr.flush()
            sys.stdout.flush()
            os._exit(0)


def main() -> None:
    """参数约定：

        pi2x_worker.py -- [--name <会话名>] [--workspace <目录>] -- <strix 原生参数>

    前面那一段是我们自己的（会话名 / 无目标时的工作目录），第二个 `--` 之后
    原样交给 strix 的 argparse。两段分开是为了绝不跟 strix 自己的选项撞名。
    """
    raw = sys.argv[1:]
    if raw and raw[0] == "--":
        raw = raw[1:]

    # 解析我们自己的前置段，直到第二个 "--"
    session_name = None
    workspace = None
    argv: list[str] = []
    i = 0
    while i < len(raw):
        a = raw[i]
        if a == "--":
            argv = raw[i + 1 :]
            break
        if a == "--name":
            session_name = raw[i + 1] if i + 1 < len(raw) else None
            i += 2
            continue
        if a == "--workspace":
            workspace = raw[i + 1] if i + 1 < len(raw) else None
            i += 2
            continue
        # 没有分隔符：全部当 strix 参数
        argv = raw[i:]
        break

    # 【父进程死了就跟着退】否则 bridge 被 kill -9 时（watchdog 重启、OOM），
    # worker 会被 init 收养变成孤儿进程，带着一整套 strix agent 和浏览器白跑，
    # 白花钱且占着端口/会话目录。SIGHUP 用于父 shell 退出时的场景。
    def _die(_signum, _frame):
        os._exit(0)

    for sig in (signal.SIGHUP, signal.SIGTERM):
        try:
            signal.signal(sig, _die)
        except (ValueError, OSError):
            pass

    try:
        asyncio.run(Worker(argv, session_name=session_name, workspace=workspace).run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
