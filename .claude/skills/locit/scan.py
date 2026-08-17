#!/usr/bin/env python3
"""Produce the locit work-list: every (locale, msgid) that needs (re)translation.

Two kinds of work, per lingui's `en-US` source + `ar`/`he` target locales:

  * untranslated — a target entry whose `msgstr` is empty.
  * stale        — the English source (en-US `msgstr`) for this msgid CHANGED in
                   git (working tree vs HEAD), so existing non-empty target
                   translations are semantically out of date and must be redone.

Usage:
    python3 scan.py [--locales-dir ui/src/locales] [--ref REV]

`--ref` is the git revision the working tree is compared against (default HEAD).
Emits a JSON array of work items on stdout:

    {"locale","msgid","source_text","reason","current","refs","comments"}

Stdlib only; no polib. Run from the repo root (needs `git`).
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from _po import parse  # noqa: E402

SOURCE_LOCALE = "en-US"


def _read(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _index(text: str) -> dict[str, str]:
    _, entries = parse(text)
    return {e.msgid: e.msgstr for e in entries}


def _git_show(rev: str, rel: str) -> str:
    try:
        return subprocess.run(
            ["git", "show", f"{rev}:{rel}"],
            capture_output=True, text=True, check=True,
        ).stdout
    except subprocess.CalledProcessError:
        return ""  # file absent at that rev → treat every source string as new


def changed_source_msgids(locales_dir: Path, ref: str, new: dict[str, str]) -> set[str]:
    """msgids whose en-US source text differs between `ref` and the working tree.

    `new` is the already-parsed working-tree en-US index (msgid→msgstr), passed in
    so the source catalog is read and parsed only once per run. The script runs
    from the repo root, so the locales-dir path is already repo-relative for git.
    """
    rel = str(locales_dir / SOURCE_LOCALE / "messages.po")
    old = _index(_git_show(ref, rel))
    return {mid for mid, cur in new.items() if mid in old and old[mid] != cur}


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--locales-dir", default="ui/src/locales")
    ap.add_argument("--ref", default="HEAD")
    args = ap.parse_args()

    locales_dir = Path(args.locales_dir)
    source_text = _index(_read(locales_dir / SOURCE_LOCALE / "messages.po"))
    changed = changed_source_msgids(locales_dir, args.ref, source_text)

    targets = sorted(
        p.name for p in locales_dir.iterdir()
        if p.is_dir() and p.name != SOURCE_LOCALE and not p.name.startswith("en")
    )

    work: list[dict] = []
    for locale in targets:
        _, entries = parse(_read(locales_dir / locale / "messages.po"))
        for e in entries:
            empty = e.msgstr.strip() == ""
            stale = (not empty) and e.msgid in changed
            if not (empty or stale):
                continue
            work.append({
                "locale": locale,
                "msgid": e.msgid,
                "source_text": source_text.get(e.msgid, e.msgid),
                "reason": "untranslated" if empty else "stale",
                "current": e.msgstr,
                "refs": e.refs,
                "comments": e.comments,
            })

    json.dump(work, sys.stdout, ensure_ascii=False, indent=2)
    print()
    print(
        f"\n# {len(work)} item(s) across {targets}: "
        f"{sum(w['reason']=='untranslated' for w in work)} untranslated, "
        f"{sum(w['reason']=='stale' for w in work)} stale",
        file=sys.stderr,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
