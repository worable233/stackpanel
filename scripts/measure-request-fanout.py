#!/usr/bin/env python3
"""
数一次页面渲染打了几次内核 —— 请求级去重是否真的生效。

## 为什么需要这个脚本

去重靠 React `cache()`，而它**只在 Next 的渲染上下文里生效**：在纯 Node
测试进程里没有渲染作用域，`cache()` 等价于直接调用，单元测试因此无法证明
"是否去重"。唯一可靠的办法是对**运行中的服务**数内核请求次数。

## 用法

    # 终端 A：起 api（写日志）
    cd apps/api && node dist/server.js > /tmp/api.log 2>&1
    # 终端 B：起 web
    cd apps/web && pnpm start
    # 终端 C：
    python3 scripts/measure-request-fanout.py /login
    python3 scripts/measure-request-fanout.py /account

脚本读 `/tmp/api.log` 里 fastify 的 `"url"` 字段，统计单个页面渲染触发的
每个端点次数，并把 >1 的标成重复。

## 基线（2026-11，本仓库）

    改前  /login   15 次，其中 /platform/info 与 /platform/brand 各 2~3 次
    改后  /login   10 次，每个端点恰好 1 次
"""

import argparse
import collections
import re
import subprocess
import sys
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    """不跟随重定向。

    跟随会把 `/account` → `/login` 两个页面算进同一次测量，重复数全是假的。
    """

    def redirect_request(self, *args, **kwargs):  # noqa: D102
        return None


def log_lines(path: str) -> int:
    out = subprocess.run(["bash", "-c", f"wc -l < {path}"], capture_output=True, text=True)
    return int(out.stdout.strip() or 0)


def measure(base: str, path: str, log: str, settle: float = 1.0) -> int:
    before = log_lines(log)
    opener = urllib.request.build_opener(NoRedirect)
    try:
        opener.open(urllib.request.Request(base + path), timeout=30)
    except urllib.error.HTTPError:
        pass  # 307/401 也会渲染 layout，正是我们要数的
    time.sleep(settle)

    out = subprocess.run(
        ["bash", "-c", f"tail -n +{before + 1} {log}"], capture_output=True, text=True
    ).stdout
    urls = re.findall(r'"url":"([^"]*)"', out)
    counts = collections.Counter(url.split("?")[0] for url in urls)

    print(f"--- {path} 单次渲染（不跟随重定向）")
    for url, count in sorted(counts.items(), key=lambda item: -item[1]):
        flag = "   <== 重复" if count > 1 else ""
        print(f"  {count}x  {url}{flag}")
    print(f"  TOTAL = {len(urls)}")

    duplicated = {url: count for url, count in counts.items() if count > 1}
    if duplicated:
        print(f"\n仍有重复: {duplicated}", file=sys.stderr)
    return 1 if duplicated else 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("path", nargs="?", default="/login")
    parser.add_argument("--base", default="http://localhost:3000")
    parser.add_argument("--log", default="/tmp/api.log")
    args = parser.parse_args()
    return measure(args.base, args.path, args.log)


if __name__ == "__main__":
    raise SystemExit(main())
