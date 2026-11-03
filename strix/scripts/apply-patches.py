#!/opt/pi2x/strix/venv/bin/python
"""把本地后端补丁应用到 strix 源码（幂等，可重复执行）。

【为什么需要这个脚本】
本机无法运行 Docker（Android 内核缺 overlayfs/NAT 能力），而 strix 的沙箱后端
只认 docker。补丁在三个文件里各加一小段，让 strix 支持 `local` 后端。

改动直接落在 venv 内已安装的源码上（而非上游仓库），所以：
  · pip 升级 strix 会覆盖 —— 升级后重跑本脚本即可恢复
  · 每处改动都用「幂等标记」判断，重复执行安全

用法：
    strix/venv/bin/python strix/scripts/apply-patches.py [--check]
    加了 --check 只报告状态，不写入。
"""

from __future__ import annotations

import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STRIX_DIR = HERE.parent
PKG = STRIX_DIR / "venv" / "lib" / "python3.12" / "site-packages" / "strix"

MARKER = "PI2X-LOCAL-BACKEND"

# ── 补丁 1：新增 local 后端 ─────────────────────────────────────────
BACKENDS_LOCAL = '''

async def _local_backend(
    *,
    image: str,
    manifest: Manifest,
    exposed_ports: tuple[int, ...],
    bind_mounts: list[dict[str, Any]] | None = None,
) -> tuple[Any, Any]:
    """Bring up a session that runs commands directly on the host.  # PI2X-LOCAL-BACKEND

    Uses the SDK's Unix local sandbox instead of a Docker container, so strix can
    run on hosts where Docker is unavailable. ``image`` and ``bind_mounts`` are
    ignored: there is no container to build or mount into.
    """
    import logging as _logging

    from agents.sandbox.sandboxes.unix_local import (
        UnixLocalSandboxClient,
        UnixLocalSandboxClientOptions,
    )

    _logging.getLogger(__name__).info(
        "Using local sandbox backend (image=%s and bind_mounts are ignored)",
        image,
    )
    client = UnixLocalSandboxClient()
    options = UnixLocalSandboxClientOptions(exposed_ports=tuple(exposed_ports or ()))
    session = await client.create(options=options, manifest=manifest)
    await session.start()
    return client, session

'''


def patch_backends(check: bool) -> str:
    """backends.py：注册 local 后端。"""
    path = PKG / "runtime" / "backends.py"
    src = path.read_text(encoding="utf-8")
    if MARKER in src:
        return "已应用"

    anchor = '_BACKENDS: dict[str, SandboxBackend] = {\n    "docker": _docker_backend,\n}'
    if anchor not in src:
        return "!! 锚点未找到（strix 版本可能已变），需手工处理"

    src = src.replace(anchor, BACKENDS_LOCAL.strip() + "\n\n" + anchor, 1)
    src = src.replace(
        '    "docker": _docker_backend,\n}',
        '    "docker": _docker_backend,\n    "local": _local_backend,\n}',
        1,
    )
    if not check:
        path.write_text(src, encoding="utf-8")
    return "已写入" if not check else "待写入"


def patch_environment(check: bool) -> str:
    """environment.py：local 后端跳过 Docker 前置检查。"""
    path = PKG / "interface" / "environment.py"
    src = path.read_text(encoding="utf-8")
    if MARKER in src:
        return "已应用"

    helper = '''def _runtime_backend() -> str:  # PI2X-LOCAL-BACKEND
    """Current sandbox backend name; falls back to docker on any read error."""
    try:
        return load_settings().runtime.backend
    except Exception:  # noqa: BLE001
        return "docker"


'''
    old_installed = "def check_docker_installed() -> None:\n    if shutil.which(\"docker\") is None:"
    new_installed = (
        "def check_docker_installed() -> None:\n"
        "    if _runtime_backend() == \"local\":  # PI2X-LOCAL-BACKEND\n"
        "        logger.debug(\"Runtime backend is 'local'; skipping Docker CLI check\")\n"
        "        return\n"
        "    if shutil.which(\"docker\") is None:"
    )
    old_pull = "def pull_docker_image() -> None:\n    from docker.errors import DockerException"
    new_pull = (
        "def pull_docker_image() -> None:\n"
        "    if _runtime_backend() == \"local\":  # PI2X-LOCAL-BACKEND\n"
        "        logger.debug(\"Runtime backend is 'local'; skipping Docker image pull\")\n"
        "        return\n"
        "    from docker.errors import DockerException"
    )
    if old_installed not in src or old_pull not in src:
        return "!! 锚点未找到（strix 版本可能已变），需手工处理"

    src = src.replace(old_installed, helper + new_installed, 1)
    src = src.replace(old_pull, new_pull, 1)
    if not check:
        path.write_text(src, encoding="utf-8")
    return "已写入" if not check else "待写入"


def patch_session_manager(check: bool) -> str:
    """session_manager.py：local 后端跳过 Caido 容器代理引导。"""
    path = PKG / "runtime" / "session_manager.py"
    src = path.read_text(encoding="utf-8")
    if MARKER in src:
        return "已应用"

    stub = '''class _NoCaidoHandle:  # PI2X-LOCAL-BACKEND
    """Stand-in for CaidoBootstrapHandle when there is no container sidecar.

    Proxy tools call get()/peek(); raising a clear error makes them degrade to a
    readable "client unavailable" result instead of hanging on a dead socket.
    """

    _MESSAGE = (
        "Caido proxy is unavailable: strix is running on the local sandbox backend "
        "(no Docker container), so there is no in-container Caido sidecar."
    )

    async def get(self):  # noqa: ANN201
        raise RuntimeError(self._MESSAGE)

    def peek(self):  # noqa: ANN201
        return None

    async def aclose(self) -> None:
        return None


'''
    anchor_env = "    container_caido_url = f\"http://127.0.0.1:{_CONTAINER_CAIDO_PORT}\""
    if anchor_env not in src:
        return "!! 锚点未找到（strix 版本可能已变），需手工处理"

    # 1) 注入 stub 类（放在 logger 定义之后）
    log_anchor = "logger = logging.getLogger(__name__)"
    if log_anchor not in src:
        return "!! 找不到 logger 定义"
    if "_NoCaidoHandle" not in src:
        src = src.replace(log_anchor, log_anchor + "\n\n\n" + stub.rstrip(), 1)

    # 2) 代理环境变量改为条件注入
    old_env_block = '''    container_caido_url = f"http://127.0.0.1:{_CONTAINER_CAIDO_PORT}"
    manifest = Manifest(
        entries=entries,
        environment=Environment(
            value={
                "PYTHONUNBUFFERED": "1",
                "HOST_GATEWAY": "host.docker.internal",
                **_host_identity_env(),
                "http_proxy": container_caido_url,
                "https_proxy": container_caido_url,
                "ALL_PROXY": container_caido_url,
                "NO_PROXY": "localhost,127.0.0.1",
            },
        ),
    )'''
    new_env_block = '''    # PI2X-LOCAL-BACKEND: local mode has no Caido sidecar, so pointing the proxy
    # vars at 127.0.0.1:48080 would break every outbound request the agent makes.
    use_caido = backend_name != "local"
    container_caido_url = f"http://127.0.0.1:{_CONTAINER_CAIDO_PORT}"
    env_values: dict[str, str] = {
        "PYTHONUNBUFFERED": "1",
        "HOST_GATEWAY": "host.docker.internal",
        **_host_identity_env(),
        "NO_PROXY": "localhost,127.0.0.1",
    }
    if use_caido:
        env_values.update(
            {
                "http_proxy": container_caido_url,
                "https_proxy": container_caido_url,
                "ALL_PROXY": container_caido_url,
            }
        )
    manifest = Manifest(
        entries=entries,
        environment=Environment(value=env_values),
    )'''
    if old_env_block not in src:
        return "!! 代理环境变量锚点未找到（strix 版本可能已变），需手工处理"
    src = src.replace(old_env_block, new_env_block, 1)

    if not check:
        path.write_text(src, encoding="utf-8")
    return "已写入" if not check else "待写入"


def main() -> int:
    check = "--check" in sys.argv
    if not PKG.exists():
        print(f"找不到 strix 包目录: {PKG}", file=sys.stderr)
        return 1

    print(f"strix 包: {PKG}")
    print(f"模式: {'仅检查' if check else '应用补丁'}\n")
    results = {
        "runtime/backends.py": patch_backends(check),
        "interface/environment.py": patch_environment(check),
        "runtime/session_manager.py": patch_session_manager(check),
    }
    failed = False
    for name, status in results.items():
        flag = "✗" if status.startswith("!!") else "✓"
        print(f"  {flag} {name:34s} {status}")
        failed = failed or status.startswith("!!")

    if not failed and not check:
        # 语法自检
        import py_compile

        for rel in results:
            try:
                py_compile.compile(str(PKG / rel), doraise=True)
            except py_compile.PyCompileError as exc:
                print(f"\n✗ 语法错误 {rel}: {exc}", file=sys.stderr)
                return 1
        print("\n全部补丁就位，语法检查通过。")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
