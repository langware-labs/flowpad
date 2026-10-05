#!/usr/bin/env python3
"""Import the SmartNavigator benchmark cases into the shipped dataset, through ``Dataset.append``.

    .venv/bin/python scripts/import_navigator_eval.py <cases.jsonl> [--dataset <folder>]

One case per row, written by the production write path (so every row is checked against
``navigator.dataset`` before anything lands). A case's ``expected`` key plus its ``alt`` keys
become the row's gold answers -- any one is right. ``category``, ``tags``, ``note`` and the case
number ride in the row's ``data``. The two ``G.abstain`` variants are ``test`` rows (they probe
holding back, not routing); every other case is ``eval``.

Refuses a dataset that already holds examples: re-importing would duplicate rows.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
DEFAULT = REPO / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/dataset/smart-navigator"
CONTEXT_KEYS = (
    "CurrentProjectTypeId",
    "CurrentProcessTypeId",
    "CurrentActiveEntityTypeId",
    "active_entity_title",
    "project_name",
    "project_path",
    "last_shown",
)


def decision(key: str, verb: str | None) -> dict:
    """A benchmark option key (``view:data-sources``, ``agentic``) as a ``navigator.decision``."""
    if key == "agentic":
        return {"route": "agentic"}
    kind, _, value = key.partition(":")
    return {"route": "quick", "target": {"kind": kind, "value": value}, "verb": verb or "show"}


def row(case: dict) -> dict:
    ctx = {k: case["context"].get(k) for k in CONTEXT_KEYS if case["context"].get(k) is not None}
    ctx["candidates"] = [{k: v for k, v in c.items() if v} for c in case["candidates"]]
    golds = [decision(k, case.get("verb")) for k in [case["expected"], *case.get("alt", [])]]
    return {
        "kind": "test" if str(case["category"]).startswith("G") else "eval",
        "input": {"utterance": case["utterance"], "page": case.get("page") or None},
        "context": ctx,
        "ground_truth": golds if len(golds) > 1 else golds[0],
        "data": {
            "case": str(case["id"]),
            "category": case["category"],
            "tags": case.get("tags", []),
            "note": case.get("note", ""),
        },
    }


async def main(cases_path: Path, folder: Path) -> None:
    from flow_sdk.builtin.dataset import Dataset
    from flow_sdk.schema.data_spec import declared
    from flow_sdk.schema.data_spec.layout import _example_dirs

    if _example_dirs(folder):
        raise SystemExit(f"{folder} already holds examples; refusing to duplicate them")
    errors = {str(f): e for f, e in declared.load_root(folder).items() if e}
    if errors:
        raise SystemExit(f"the dataset's data specs did not register: {errors}")
    ds = Dataset.at(folder)
    cases = [json.loads(line) for line in cases_path.read_text().splitlines() if line.strip()]
    ids = await ds.append([row(c) for c in cases])
    print(f"appended {len(ids)} rows to {folder}")  # noqa: T201 -- a script reports
    problems = ds.validate_rows()
    if problems:
        raise SystemExit(f"rows that do not read back: {problems}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("cases", type=Path)
    ap.add_argument("--dataset", type=Path, default=DEFAULT)
    a = ap.parse_args()
    asyncio.run(main(a.cases, a.dataset))
