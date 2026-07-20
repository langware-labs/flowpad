#!/usr/bin/env python3
"""Write final translations back into the target .po files, one msgstr at a time.

Reads a JSON array from a file (or stdin) of:

    [{"locale": "he", "msgid": "<source key>", "translation": "<final text>"}, ...]

For each item it locates the entry by msgid in
`<locales-dir>/<locale>/messages.po` and replaces ONLY that entry's `msgstr`
block with a single `msgstr "<escaped>"` line — every other byte (sort order,
comments, wrapping, header) is left untouched, so the diff stays minimal and
lingui-compatible. Multi-locale, multi-entry safe: edits are applied per file
from the bottom up so line offsets never shift.

Usage:
    python3 apply.py results.json [--locales-dir ui/src/locales]
    cat results.json | python3 apply.py - [--locales-dir ui/src/locales]

Stdlib only.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _po import Entry, escape, parse  # noqa: E402


def apply_file(path: Path, edits: list[tuple[str, str]]) -> tuple[int, list[str]]:
    """edits = [(msgid, translation)]. Returns (count_applied, missing_msgids)."""
    text = path.read_text(encoding="utf-8")
    lines, entries = parse(text)
    by_id: dict[str, Entry] = {}
    for e in entries:
        by_id.setdefault(e.msgid, e)  # first (non-obsolete) wins

    planned: list[tuple[Entry, str]] = []
    missing: list[str] = []
    for msgid, translation in edits:
        e = by_id.get(msgid)
        if e is None:
            missing.append(msgid)
            continue
        planned.append((e, translation))

    # Find each entry's msgstr line span and rewrite bottom-up.
    planned.sort(key=lambda p: p[0].start, reverse=True)
    for e, translation in planned:
        # msgstr block runs from the msgstr line to entry end (e.end).
        ms = e.start
        while ms < e.end and not lines[ms].startswith("msgstr"):
            ms += 1
        lines[ms:e.end] = [f'msgstr "{escape(translation)}"']

    path.write_text("\n".join(lines), encoding="utf-8")
    return len(planned), missing


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("results", help="JSON file, or '-' for stdin")
    ap.add_argument("--locales-dir", default="ui/src/locales")
    args = ap.parse_args()

    raw = sys.stdin.read() if args.results == "-" else Path(args.results).read_text("utf-8")
    items = json.loads(raw)

    grouped: dict[str, list[tuple[str, str]]] = defaultdict(list)
    for it in items:
        grouped[it["locale"]].append((it["msgid"], it["translation"]))

    total, all_missing = 0, []
    for locale, edits in grouped.items():
        path = Path(args.locales_dir) / locale / "messages.po"
        applied, missing = apply_file(path, edits)
        total += applied
        all_missing += [f"{locale}: {m}" for m in missing]
        print(f"{locale}: applied {applied}/{len(edits)}", file=sys.stderr)

    if all_missing:
        print("MISSING (msgid not found — skipped):", file=sys.stderr)
        for m in all_missing:
            print(f"  {m}", file=sys.stderr)
    print(f"TOTAL applied: {total}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
