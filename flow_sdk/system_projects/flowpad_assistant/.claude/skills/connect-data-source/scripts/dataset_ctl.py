#!/usr/bin/env python3
"""Dataset mechanics for the connect-data-source `define` mode. One JSON object per call.

The person decides the SHAPE of what they want out of each item; everything
after that is mechanical and identical every time, so it lives here: sample the
items, create the dataset bound to the source, promote items into rows, write
gold labels, read the counts back. Same gate-safe transport as `source_ctl.py`
(`discover_port` + `local_get`/`local_post`), same output contract:
`{"ok": true, ...}` or `{"ok": false, "error_code", "error"}` + exit 1.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from _ctl_common import create_and_verify, one, run  # noqa: E402
from _ctl_common import get as _get
from _ctl_common import json_arg as _json_arg
from _ctl_common import one_source as _source
from _ctl_common import post as _post

#: Every scalar a caller needs about a dataset — spelled once, used by `list`
#: and `snapshot` so the two never drift.
DATASET_FIELDS = ("id", "name", "title", "source_id", "data_layout", "num_examples", "num_annotated", "kind_counts", "spec", "asset_ref")


def _dataset(ref: str) -> dict:
    """A dataset by id, name or title — the shared resolver, same refusal."""
    return one("/graph/dataset", ref, label="dataset", fields=("name", "title"))


# ── verbs ────────────────────────────────────────────────────────────────

ITEM_FIELDS = ("id", "external_id", "name", "body", "author_display", "occurred_at", "permalink", "segment_label")


def cmd_sample(args) -> dict:
    """What the items actually look like — the evidence the SHAPE question is asked over."""
    source = _source(args.source)
    rows = list(_get("/graph/source_item", data_source_id=source["id"], limit=args.limit) or [])
    return {"source_id": source["id"], "count": len(rows),
            "items": [{k: r.get(k) for k in ITEM_FIELDS} for r in rows]}


def cmd_create(args) -> dict:
    """Create the dataset bound to a source, then READ IT BACK and diff — the
    create route drops keys it does not know, so the read-back is the evidence.

    Payload: {"project_id", "name", "title"?, "source": <source ref>, "output": {<field>: <kind>}}
    The dataset's spec is ALWAYS `input: ingest.source_item` — the item envelope —
    so `output` is the only shape the person authors.
    """
    from flow_sdk.builtin.source_item import SourceItemSpec  # noqa: PLC0415

    payload = _json_arg(args.json)
    source = _source(str(payload.pop("source")))
    project_id = payload.pop("project_id", None) or source.get("project_id")
    if not project_id:
        raise RuntimeError("project_id is required (the source carries none)")
    output = payload.pop("output")
    body = {
        "type": "dataset", "data_layout": "io_folder", "source_id": source["id"],
        # The declaration, never a literal: a rename of the item envelope's kind
        # must not leave this script writing a spec nothing accepts.
        "spec": {"examples": [{"input": SourceItemSpec.spec_kind, "output": output}]},
        **payload,
    }
    new_id, row, dropped = create_and_verify(
        f"/graph/project/{project_id}/dataset", body,
        ("name", "title", "source_id", "data_layout", "spec"), read_path="/graph/dataset",
    )
    return {"id": new_id, "typeid": f"dataset-{new_id}", "source_id": row.get("source_id"),
            "spec": row.get("spec"), "folder": row.get("asset_ref"), "dropped": dropped}


def cmd_list(args) -> dict:
    rows = list(_get("/graph/dataset", **({"source_id": _source(args.source)["id"]} if args.source else {})) or [])
    return {"datasets": [{k: r.get(k) for k in DATASET_FIELDS} for r in rows]}


def cmd_promote(args) -> dict:
    ds = _dataset(args.dataset)
    out = _post(f"/graph/dataset/{ds['id']}/promote", {"source_item_ids": list(args.item)}) or {}
    return {"id": ds["id"], **out}


def cmd_annotate(args) -> dict:
    ds = _dataset(args.dataset)
    out = _post(f"/graph/dataset/{ds['id']}/annotate", {"example_id": args.example, "ground_truth": _json_arg(args.json)}) or {}
    return {"id": ds["id"], **out}


def cmd_snapshot(args) -> dict:
    """Counts + shape + the last rows, read back from the row the indexer derived."""
    row = _get(f"/graph/dataset/{_dataset(args.dataset)['id']}") or {}
    return {k: row.get(k) for k in DATASET_FIELDS}


VERBS = {
    "sample": (cmd_sample, [("source", {}), ("--limit", {"type": int, "default": 5})]),
    "create": (cmd_create, [("json", {"help": "JSON payload, or - for stdin"})]),
    "list": (cmd_list, [("--source", {})]),
    "promote": (cmd_promote, [("dataset", {}), ("item", {"nargs": "+"})]),
    "annotate": (cmd_annotate, [("dataset", {}), ("example", {}), ("json", {"help": "ground truth JSON, or - for stdin"})]),
    "snapshot": (cmd_snapshot, [("dataset", {})]),
}


if __name__ == "__main__":
    sys.exit(run(VERBS, __doc__))
