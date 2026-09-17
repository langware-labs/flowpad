#!/usr/bin/env python3
"""Merge `agentic_process.load` front + back lines into one click-relative timeline.

Frontend lines reach the instance log in once-a-second batches, so their log
timestamp lies; each carries ``(client_ts=<epoch ms>)`` — the moment it was
logged in the page. Backend lines use their own log timestamp. This orders both
on one clock and prints every line as ``+ms`` from an ``openNewChat click``.

Usage:
    python load_timeline.py <instance log> [nth click, default -1 = last]

Read a line's gap to the next one: a big gap between two FE lines with no BE
line inside is the page (main thread, or a hidden tab's throttled timers — the
click line's ``visibility=`` says which); a big gap inside BE lines is the
backend step that line closes.
"""
from __future__ import annotations

import datetime as dt
import re
import sys

TAG = "agentic_process.load"
CLIENT_TS = re.compile(r"client_ts=(\d+)")
CLIENT_TS_SUFFIX = re.compile(r"\s*\(client_ts=\d+\)")
TAG_PREFIX = re.compile(r".*?\[[^\]]*" + re.escape(TAG) + r"[^\]]*\]\s*")


def rows(path: str) -> list[tuple[dt.datetime, str, str]]:
    out = []
    with open(path, errors="replace") as log:
        lines = list(log)
    for line in lines:
        if TAG not in line or not line[:4].isdigit():
            continue
        client = CLIENT_TS.search(line)
        if client:
            at = dt.datetime.fromtimestamp(int(client.group(1)) / 1000)
        else:
            at = dt.datetime.strptime(line[:23], "%Y-%m-%d %H:%M:%S,%f")
        msg = CLIENT_TS_SUFFIX.sub("", TAG_PREFIX.sub("", line))
        out.append((at, "FE" if client else "BE", msg.strip()))
    return sorted(out, key=lambda r: r[0])


def main() -> None:
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    nth = int(sys.argv[2]) if len(sys.argv) > 2 else -1
    all_rows = rows(sys.argv[1])
    clicks = [i for i, r in enumerate(all_rows) if "openNewChat click" in r[2]]
    if not clicks:
        sys.exit(f"no '{TAG}' click line in {sys.argv[1]} — is the tag on, and the page reloaded?")
    start = clicks[nth]
    later = [i for i in clicks if i > start]
    t0 = all_rows[start][0]
    # Backend lines can land a few ms before the click line's client clock.
    lo = t0 - dt.timedelta(milliseconds=50)
    hi = all_rows[later[0]][0] if later else None
    for at, side, msg in all_rows:
        if at < lo or (hi is not None and at >= hi):
            continue
        print(f"{(at - t0).total_seconds() * 1000:+7.0f} {side} {msg[:160]}")  # noqa: T201 — CLI output


if __name__ == "__main__":
    main()
