#!/usr/bin/env python3
"""Import the SmartNavigator benchmark cases into the SmartNavigator dataset, through ``Dataset.append``.

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


def here_of(page: str | None, ctx: dict) -> dict | None:
    """A case's page + context slots as a ``navigation.here``: the place its page names, and the
    project, session, open entity and last display it recorded."""
    from flow_sdk.core.dock_address import parse_dock_url

    here: dict = {}
    if page and (addr := parse_dock_url(page)) is not None:
        here = {"view": addr.view_type.value, "pointer": addr.pointer, "page": addr.page.value, "address": page}
    if ctx.get("CurrentProjectTypeId"):
        here["project"] = {
            "typeid": ctx["CurrentProjectTypeId"],
            "title": ctx.get("project_name"),
            "path": ctx.get("project_path"),
        }
    entity = ctx.get("CurrentActiveEntityTypeId")
    if ctx.get("CurrentProcessTypeId"):
        here["process"] = {"typeid": ctx["CurrentProcessTypeId"]}
        if ctx["CurrentProcessTypeId"] == entity:
            here["process"]["title"] = ctx.get("active_entity_title")
    if entity:
        here["entity"] = {"typeid": entity, "title": ctx.get("active_entity_title")}
    if ctx.get("last_shown"):
        here["last_shown"] = ctx["last_shown"]
    return _drop_none(here) or None


def _drop_none(value):
    if isinstance(value, dict):
        return {k: _drop_none(v) for k, v in value.items() if v is not None}
    return value


def decision(key: str, verb: str | None) -> dict:
    """A benchmark option key (``view:data-sources``, ``agentic``) as a ``navigator.decision``."""
    if key == "agentic":
        return {"route": "agentic"}
    kind, _, value = key.partition(":")
    return {"route": "quick", "target": {"kind": kind, "value": value}, "verb": verb or "show"}


def row(case: dict) -> dict:
    ctx = {"candidates": [{k: v for k, v in c.items() if v} for c in case["candidates"]]}
    golds = [decision(k, case.get("verb")) for k in [case["expected"], *case.get("alt", [])]]
    return {
        "kind": "test" if str(case["category"]).startswith("G") else "eval",
        "input": _drop_none({"utterance": case["utterance"], "here": here_of(case.get("page"), case["context"])}),
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
        raise SystemExit(f"the dataset's data schemas did not register: {errors}")
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
    from flow_sdk.core.navigation import DATASET

    ap.add_argument("--dataset", type=Path, default=DATASET)
    a = ap.parse_args()
    asyncio.run(main(a.cases, a.dataset))
