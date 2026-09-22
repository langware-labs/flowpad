#!/usr/bin/env python3
"""Merge front + back toplog lines into one timeline — per new-chat click, or per tab switch.

Frontend lines reach the instance log in once-a-second batches, so their log
timestamp lies; each carries ``(client_ts=<epoch ms>)`` — the moment it was
logged in the page. Backend lines use their own log timestamp. This orders both
on one clock and prints every line as ``+ms`` from an anchor line.

Usage:
    python load_timeline.py <instance log> [nth click, default -1 = last]
        `agentic_process.load` lines, anchored on `openNewChat click` (the original mode).

    python load_timeline.py <instance log> --switch all
        one row per `tab_switch` switch: via, target, loader/committed/painted/ready ms, errors.

    python load_timeline.py <instance log> --switch <n>|last
        switch n in full: its `tab_switch` lines plus every `pty`, `process_load`,
        `agentic_process.load`, `http` and `navigation` line inside its window
        (start → next start), front and back on one clock.

Read a line's gap to the next one: a big gap between two FE lines with no BE
line inside is the page (main thread, or a hidden tab's throttled timers — the
anchor line's ``visibility=`` says which); a big gap inside BE lines is the
backend step that line closes.
"""
from __future__ import annotations

import argparse
import datetime as dt
import re
import sys

CLIENT_TS = re.compile(r"client_ts=(\d+)")
CLIENT_TS_SUFFIX = re.compile(r"\s*\(client_ts=\d+\)")
TAGS = re.compile(r"toplog(?:\.client)?: \[([^\]]+)\]\s*")
SW = re.compile(r"\bsw=(\d+)")
PLUS_MS = re.compile(r" \+(\d+)ms\b")
FIELD = re.compile(r"\b(\w+)=(\S+)")

SWITCH_TAG = "tab_switch"
# The internals a switch's window pulls in next to its own spine.
SWITCH_COMPANIONS = {"pty", "process_load", "agentic_process.load", "http", "navigation"}


def rows(path: str, wanted: set[str]) -> list[tuple[dt.datetime, str, set[str], str]]:
    out = []
    with open(path, errors="replace") as log:
        lines = list(log)
    for line in lines:
        if not line[:4].isdigit():
            continue
        m = TAGS.search(line)
        if not m:
            continue
        tags = {t.strip() for t in m.group(1).split(",")}
        if not tags & wanted:
            continue
        client = CLIENT_TS.search(line)
        if client:
            at = dt.datetime.fromtimestamp(int(client.group(1)) / 1000)
        else:
            at = dt.datetime.strptime(line[:23], "%Y-%m-%d %H:%M:%S,%f")
        msg = CLIENT_TS_SUFFIX.sub("", line[m.end():])
        out.append((at, "FE" if client else "BE", tags, msg.strip()))
    return sorted(out, key=lambda r: r[0])


def click_mode(path: str, nth: int) -> None:
    tag = "agentic_process.load"
    all_rows = rows(path, {tag})
    clicks = [i for i, r in enumerate(all_rows) if "openNewChat click" in r[3]]
    if not clicks:
        sys.exit(f"no '{tag}' click line in {path} — is the tag on, and the page reloaded?")
    start = clicks[nth]
    later = [i for i in clicks if i > start]
    t0 = all_rows[start][0]
    # Backend lines can land a few ms before the click line's client clock.
    lo = t0 - dt.timedelta(milliseconds=50)
    hi = all_rows[later[0]][0] if later else None
    for at, side, _tags, msg in all_rows:
        if at < lo or (hi is not None and at >= hi):
            continue
        print(f"{(at - t0).total_seconds() * 1000:+7.0f} {side} {msg[:160]}")  # noqa: T201 — CLI output


def switch_starts(all_rows) -> list[int]:
    return [i for i, r in enumerate(all_rows) if SWITCH_TAG in r[2] and r[3].startswith("start ")]


def switch_summary(path: str) -> None:
    all_rows = rows(path, {SWITCH_TAG})
    # A page (re)load restarts the ids at 0 — each load is its own run, keyed
    # `<run>.<sw>` so three loads' `sw=0` lines don't merge into one row.
    by_sw: dict[tuple[int, int], list[str]] = {}
    # Within one id `+ms` only grows, so it going backwards is a reload too
    # (two loads in a row are both `sw=0`).
    run, last, last_ms = 0, -1, -1
    for _at, _side, _tags, msg in all_rows:
        m = SW.search(msg)
        if m and not msg.startswith("noop "):
            sw = int(m.group(1))
            p = PLUS_MS.search(msg)
            ms = 0 if msg.startswith("start ") else (int(p.group(1)) if p else last_ms)
            if sw < last or (sw == last and ms < last_ms):
                run += 1
            last, last_ms = sw, ms
            by_sw.setdefault((run, sw), []).append(msg)
    noops = sum(1 for r in all_rows if r[3].startswith("noop "))
    unattributed = [r[3] for r in all_rows if not SW.search(r[3])]
    if not by_sw:
        sys.exit(f"no '{SWITCH_TAG}' lines in {path} — is the tag on, and the page reloaded?")
    header = f"{'sw':>5} {'via':<9} {'to':<44} {'loader':>7} {'commit':>7} {'paint':>7} {'ready':>7} {'ready kind/mode':<20} errors"
    print(header)  # noqa: T201
    for (run, sw_n), msgs in sorted(by_sw.items()):
        sw = f"{run}.{sw_n}" if run else str(sw_n)
        start = next((m for m in msgs if m.startswith("start ")), "")
        if start:
            f = dict(FIELD.findall(start))
        else:  # a page load has no `start`; name it by the first path/dock it logged
            fields = [dict(FIELD.findall(m)) for m in msgs]
            f = {"via": "pageload", "to": next((x.get("path") or x.get("dock") for x in fields if x.get("path") or x.get("dock")), "?")}

        def at(event: str) -> str:
            line = next((m for m in msgs if m.startswith(event + " ")), None)
            p = PLUS_MS.search(line) if line else None
            return f"{p.group(1)}" if p else "-"

        ready = next((m for m in msgs if m.startswith("ready ")), "")
        rf = dict(FIELD.findall(ready))
        errors = [dict(FIELD.findall(m)).get("sink", "?") for m in msgs if m.startswith(("error ", "uncaught ", "loader_error "))]
        loader = next((m for m in msgs if m.startswith("loader ")), "")
        print(  # noqa: T201
            f"{sw:>5} {f.get('via', '?'):<9} {f.get('to', '?')[:44]:<44} "
            f"{dict(FIELD.findall(loader)).get('ms', '-'):>7} {at('committed'):>7} {at('painted'):>7} {at('ready'):>7} "
            f"{(rf.get('kind', '-') + '/' + rf.get('mode', '-')) if ready else '-':<20} {','.join(errors) or '-'}"
        )
    print(f"\n{len(by_sw)} switches, {noops} noop clicks, {len(unattributed)} lines without sw= (SDK-side errors)")  # noqa: T201
    for msg in unattributed:
        print(f"  {msg[:160]}")  # noqa: T201


def switch_detail(path: str, which: str) -> None:
    all_rows = rows(path, {SWITCH_TAG} | SWITCH_COMPANIONS)
    starts = switch_starts(all_rows)
    if not starts:
        sys.exit(f"no '{SWITCH_TAG}' start line in {path} — is the tag on, and the page reloaded?")
    if which == "last":
        start = starts[-1]
    else:
        match = [i for i in starts if SW.search(all_rows[i][3]) and SW.search(all_rows[i][3]).group(1) == which]
        if not match:
            sys.exit(f"no 'start sw={which}' line in {path}")
        start = match[0]
    later = [i for i in starts if i > start]
    t0 = all_rows[start][0]
    lo = t0 - dt.timedelta(milliseconds=50)
    hi = all_rows[later[0]][0] if later else None
    for at, side, tags, msg in all_rows:
        if at < lo or (hi is not None and at >= hi):
            continue
        label = SWITCH_TAG if SWITCH_TAG in tags else sorted(tags)[0]
        print(f"{(at - t0).total_seconds() * 1000:+7.0f} {side} {label:<20} {msg[:150]}")  # noqa: T201


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("log")
    parser.add_argument("nth", nargs="?", type=int, default=-1, help="nth openNewChat click (click mode)")
    parser.add_argument("--switch", dest="switch", help="'all' for the summary, or a switch id / 'last' for its window")
    args = parser.parse_args()
    if args.switch is None:
        click_mode(args.log, args.nth)
    elif args.switch == "all":
        switch_summary(args.log)
    else:
        switch_detail(args.log, args.switch)


if __name__ == "__main__":
    main()
