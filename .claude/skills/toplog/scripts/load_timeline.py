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


def print_window(all_rows, start: int, anchors: list[int], label) -> None:
    """Every row from `start` up to the next anchor, as `+ms` from `start`."""
    later = [i for i in anchors if i > start]
    t0 = all_rows[start][0]
    # Backend lines can land a few ms before the anchor line's client clock.
    lo = t0 - dt.timedelta(milliseconds=50)
    hi = all_rows[later[0]][0] if later else None
    for at, side, tags, msg in all_rows:
        if lo <= at and (hi is None or at < hi):
            print(f"{(at - t0).total_seconds() * 1000:+7.0f} {side} {label(tags)}{msg[:150]}")  # noqa: T201 — CLI output


def click_mode(path: str, nth: int) -> None:
    tag = "agentic_process.load"
    all_rows = rows(path, {tag})
    clicks = [i for i, r in enumerate(all_rows) if "openNewChat click" in r[3]]
    if not clicks:
        sys.exit(f"no '{tag}' click line in {path} — is the tag on, and the page reloaded?")
    print_window(all_rows, clicks[nth], clicks, lambda _tags: "")


def switch_starts(all_rows) -> list[int]:
    return [i for i, r in enumerate(all_rows) if SWITCH_TAG in r[2] and r[3].startswith("start ")]


def switch_summary(path: str) -> None:
    # (event, fields, plus_ms, msg, origin) per line, parsed once. `origin` is
    # the page-clock moment the line's switch started (its time minus `+ms`):
    # constant for every line of one switch, and a jump of seconds when the page
    # reloaded — a reload restarts the ids at 0, so it is the only way to tell
    # two loads' `sw=0` apart.
    events = []
    for at, _side, _tags, msg in rows(path, {SWITCH_TAG}):
        p = PLUS_MS.search(msg)
        origin = at - dt.timedelta(milliseconds=int(p.group(1)) if p else 0)
        events.append((msg.split(" ", 1)[0], dict(FIELD.findall(msg)), p.group(1) if p else None, msg, origin))
    by_sw: dict[tuple[int, int], list] = {}
    run, last, last_origin = 0, -1, None
    for ev in events:
        event, fields, _plus, _msg, origin = ev
        if "sw" not in fields or event == "noop":
            continue
        sw = int(fields["sw"])
        reloaded = sw < last or (sw == last and abs((origin - last_origin).total_seconds()) > 0.5)
        if reloaded:
            run += 1
        if reloaded or sw != last or event == "start":
            last_origin = origin
        last = sw
        by_sw.setdefault((run, sw), []).append(ev)
    if not by_sw:
        sys.exit(f"no '{SWITCH_TAG}' lines in {path} — is the tag on, and the page reloaded?")
    print(f"{'sw':>5} {'via':<9} {'to':<44} {'loader':>7} {'commit':>7} {'paint':>7} {'ready':>7} {'ready kind/mode':<20} errors")  # noqa: T201
    for (run, sw_n), evs in sorted(by_sw.items()):
        first = {}
        for event, fields, plus, _msg, _o in evs:
            first.setdefault(event, (fields, plus))
        if "start" in first:
            via, to = first["start"][0].get("via", "?"), first["start"][0].get("to", "?")
        else:  # a page load has no `start`; name it by the first path/dock it logged
            via = "pageload"
            to = next((f.get("path") or f.get("dock") for _e, f, _p, _m, _o in evs if f.get("path") or f.get("dock")), "?")
        ready = first.get("ready", ({}, None))[0]
        errors = [f.get("sink", e) for e, f, _p, _m, _o in evs if e in ("error", "uncaught", "loader_error")]
        print(  # noqa: T201
            f"{f'{run}.{sw_n}' if run else sw_n:>5} {via:<9} {to[:44]:<44} "
            f"{first.get('loader', ({}, None))[0].get('ms', '-'):>7} "
            f"{first.get('committed', ({}, '-'))[1] or '-':>7} {first.get('painted', ({}, '-'))[1] or '-':>7} "
            f"{first.get('ready', ({}, '-'))[1] or '-':>7} "
            f"{(ready.get('kind', '-') + '/' + ready.get('mode', '-')) if ready else '-':<20} {','.join(errors) or '-'}"
        )
    noops = sum(1 for e in events if e[0] == "noop")
    unattributed = [e[3] for e in events if "sw" not in e[1]]
    print(f"\n{len(by_sw)} switches, {noops} noop clicks, {len(unattributed)} lines without sw=")  # noqa: T201
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
        match = [i for i in starts if (m := SW.search(all_rows[i][3])) and m.group(1) == which]
        if not match:
            sys.exit(f"no 'start sw={which}' line in {path}")
        start = match[0]
    print_window(all_rows, start, starts, lambda tags: f"{SWITCH_TAG if SWITCH_TAG in tags else sorted(tags)[0]:<20} ")


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
