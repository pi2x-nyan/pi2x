#!/usr/bin/env python3
"""strix 工具链自检 —— 列出 strix 本地沙箱可见的工具。

用法: python3 strix/scripts/toolcheck.py

【为什么要单独做这个检查】
strix 本地模式（无 Docker）跑在宿主机上，所以能用的工具 = 宿主机已装的。
官方 Kali 容器自带一整套，本机需要自行补。这个脚本对照「strix 技能文档里
提到的工具」逐项验证可见性，并明确列出**故意未装**的爆破类工具。
"""

import shutil
import sys

# strix 沙箱内部使用的 PATH（含 sbin —— 不少安全工具装在那里）
SANDBOX_PATH = "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin"

# 分组：名称 -> (工具列表, 是否为故意不装的爆破类)
GROUPS: list[tuple[str, list[str], bool]] = [
    ("端口与主机", ["nmap", "masscan", "nc", "ncat", "netstat", "ifconfig", "ping", "dig", "whois"], False),
    ("HTTP 探测", ["curl", "httpx", "hurl", "openssl", "jq"], False),
    ("爬取", ["katana"], False),
    ("漏洞扫描", ["nuclei", "nikto", "sqlmap"], False),
    ("指纹识别", ["whatweb", "wafw00f"], False),
    ("子域与资产", ["subfinder", "naabu"], False),
    ("二进制与取证", ["file", "xxd", "gdb", "strings", "rg", "ndiff"], False),
    ("脚本运行时", ["python3", "node", "perl", "parallel"], False),
    ("【故意不装】爆破类", ["ffuf", "gobuster", "dirb", "dirsearch", "hydra", "hashcat", "john"], True),
]


def find(tool: str) -> str | None:
    """在 strix 沙箱的 PATH 里查找工具（含 sbin）。"""
    for d in SANDBOX_PATH.split(":"):
        p = f"{d}/{tool}"
        import os

        if os.path.isfile(p) and os.access(p, os.X_OK):
            return p
    return shutil.which(tool)


def main() -> int:
    print("strix 本地工具链自检")
    print("─" * 64)
    ok = miss = 0
    for name, tools, is_brute in GROUPS:
        marks = []
        for t in tools:
            if find(t):
                marks.append(f"✓{t}")
                ok += 1
            else:
                marks.append(f"✗{t}")
                miss += 1
        label = f"{name:16s}"
        print(f"{label} " + " ".join(marks))
        if is_brute and any(find(t) for t in tools):
            print(f"{'':16s}   ⚠ 检测到爆破类工具（按需求应为未装）")
    print("─" * 64)
    print(f"可用 {ok} · 缺失 {miss}")
    missing = [t for _, tools, b in GROUPS if not b for t in tools if not find(t)]
    if missing:
        print("缺失（非爆破类）:", ", ".join(missing))
    return 0


if __name__ == "__main__":
    sys.exit(main())
