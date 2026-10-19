#!/usr/bin/env python3
"""How much of the app the smart navigator covers: every sentence in
``docs/navigation/navigation-sentences.md`` through ``navigation_decision.decide``.

    set -a; . ./.env.<instance>.local; set +a          # reach that instance's hub decision API
    .venv/bin/python scripts/navigation_coverage.py [--out <file.md>]

Each row is judged against its ``target``:

* ``hit``  -- opened the expected place (its address starts with the target, placeholders aside),
  or, for ``entity:`` / ``file:`` / ``url:`` / ``log:``, decided that kind of target;
* ``near`` -- opened the right screen, another tab or pointer of it;
* ``wrong`` -- opened something else;
* ``asked`` -- handed it to the assistant (for an ``ACTION:`` row that is the known gap, ``gap``).

Calls ``decide`` directly, never the ``navigation-decision`` action, so nothing lands in the
instance's SmartNavigationLog.
"""

from __future__ import annotations

import argparse
import asyncio
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
HERE = {"view": "home", "address": "/dock/home"}


def rows() -> list[tuple[str, int, str, str]]:
    """``(group, n, sentence, target)`` for every row of the doc -- the importer's parser, one of it."""
    sys.path.insert(0, str(REPO / "scripts"))
    from import_navigation_sentences import rows as sentence_rows

    return [(r["group"], r["n"], r["sentence"], r["target"]) for r in sentence_rows()]


def _prefix(target: str) -> str:
    return re.split(r"[<…( ]", target, maxsplit=1)[0].rstrip("/")


def verdict(target: str, outcome) -> str:
    address = outcome.address or ""
    decided = outcome.decision.target.kind if outcome.decision.target else None
    if target.startswith("ACTION:"):
        return "gap" if outcome.prompt is not None else f"opened {address or decided}"
    if outcome.prompt is not None:
        return "asked"
    kind = target.split(":", 1)[0]
    if kind in ("entity", "file", "url", "log"):
        return "hit" if decided == kind else "wrong"
    want = _prefix(target)
    if address.startswith(want) or address.split("?")[0] == want.split("?")[0]:
        return "hit"
    view = lambda a: a.split("?")[0].removeprefix("/dock/").removeprefix("hub/").split("/")[0]  # noqa: E731
    return "near" if view(address) == view(want) else "wrong"


async def main(out: Path | None) -> None:
    from flow_sdk.core.navigation_decision import decide
    from flow_sdk.decision import decision_endpoints

    if not await decision_endpoints():
        raise SystemExit("no decision API reachable -- load an instance's env first (see the docstring)")
    lines = ["| # | group | sentence | target | verdict | answered |", "|---|---|---|---|---|---|"]
    by_group: dict[str, Counter] = defaultdict(Counter)
    for group, n, sentence, target in rows():
        outcome = await decide({"utterance": sentence, "here": HERE})
        v = verdict(target, outcome)
        by_group[group][v.split()[0]] += 1
        answered = outcome.address or (f"→ assistant ({outcome.decision.confidence or 0:.2f})" if outcome.prompt else "")
        lines.append(f"| {n} | {group[0]} | {sentence} | {target} | {v} | {answered or outcome.decision.target} |")
    total: Counter = sum(by_group.values(), Counter())
    summary = ["| group | hit | near | wrong | asked | gap (ACTION) | opened (ACTION) |", "|---|---|---|---|---|---|---|"]
    for group, c in list(by_group.items()) + [("ALL", total)]:
        summary.append(f"| {group} | {c['hit']} | {c['near']} | {c['wrong']} | {c['asked']} | {c['gap']} | {c['opened']} |")
    report = "\n".join(["# Navigation coverage", "", *summary, "", *lines, ""])
    if out:
        out.write_text(report)
    print("\n".join(summary))  # noqa: T201 -- a script reports


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", type=Path)
    asyncio.run(main(ap.parse_args().out))
