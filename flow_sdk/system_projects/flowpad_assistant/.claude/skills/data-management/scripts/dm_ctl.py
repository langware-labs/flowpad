#!/usr/bin/env python3
"""Data-management mechanics: probe projects, kinds, values and dataset rows. One JSON object per call.

Run it with the worker's own interpreter -- ``"$FLOWPAD_PYTHON" <skill>/scripts/dm_ctl.py <verb> ...``
-- never a bare ``python3``, which may not have ``flow_sdk``. Every call goes to THIS instance's
backend (``FLOW_INSTANCE`` is pinned for the worker) through the gate-safe transport of the
``flow`` CLI (``local_get``/``local_post``); a bare ``curl`` gets the cookie gate's 403.

Output: ``{"ok": true, ...}`` or ``{"ok": false, "error_code", "error", ...}`` with exit 1.

Verbs
  probe-new                          a throwaway project in $TMPDIR with its own namespace
  probe-copy ROOT SRC [SRC ...]      copy schema / dataset folders into a probe, re-namespaced
  probe-drop PROJECT_ID              delete the probe: its rows, its kinds' rows, its folder
  kind KIND                          a registered kind's fields (``flow schema info`` takes entity types)
  check KIND VALUE                   would VALUE fit KIND? (an unknown kind is an error, never "fits")
  ds-find KIND                       the datasets whose rows are KIND
  ds-rows DATASET                    every row with its key
  ds-row DATASET KEY                 one row, by key or id
  ds-append DATASET ROWS             rows in (each may carry a "key"); one bad row writes nothing
  ds-put DATASET KEY ROW             create or replace the row KEY
  ds-delete DATASET KEY              remove one row (--expected VERSION: refuse a row changed since)
  ds-store-ids DATASET               store each row's id where it only has the legacy derived one
  ds-rename DATASET KEY NEW_KEY      move a row to a new key (its id stays; --expected VERSION)
  ds-check DATASET ROW               would ROW fit? writes nothing
  ds-validate DATASET                every row checked against the dataset's shape

DATASET is a dataset id, name, title, or its folder path. VALUE / ROWS / ROW are JSON, or ``-`` for stdin.
"""
from __future__ import annotations

import json
import re
import shutil
import sys
import tempfile
import uuid
from functools import lru_cache
from pathlib import Path
from typing import Any
from urllib.parse import quote

PROBE_PREFIX = "dm-probe-"
#: A namespaced kind (``--acme--.crm.lead``) starts with ``--``; argparse would read it as an option.
NS_KIND = re.compile(r"^--[A-Za-z0-9_]+--\.")
_SHIELD = "\x00"
SCHEMA_DOC, DATASET_DOC = "data_schema.json", "dataset.json"


# ── transport ────────────────────────────────────────────────────────────────

@lru_cache(maxsize=1)
def _base() -> str:
    from flow_sdk.cli.commands._common import discover_port  # noqa: PLC0415

    return f"http://127.0.0.1:{discover_port()}/api/v1"


class ApiError(RuntimeError):
    def __init__(self, status: int, message: str, data: Any = None):
        super().__init__(f"HTTP {status}: {message}")
        self.status, self.data = status, data


def _call(method: str, path: str, body: Any = None) -> Any:
    """The envelope's ``data`` -- or ``ApiError`` carrying the server's message and its ``data``
    (a 400's validation ``errors``), so the caller sees WHY, not just that it failed."""
    from flow_sdk.cli.commands._common import bad_response_message, local_request  # noqa: PLC0415

    resp = local_request(method, f"{_base()}{path}", json=body if method != "GET" else None, timeout=60)
    try:
        envelope = resp.json() or {}
    except ValueError:
        raise RuntimeError(bad_response_message(resp)) from None
    if resp.status_code >= 400 or str(envelope.get("status")).lower() == "fail":
        raise ApiError(resp.status_code, envelope.get("message") or resp.reason, envelope.get("data"))
    return envelope.get("data")


def _json(raw: str) -> Any:
    return json.loads(sys.stdin.read() if raw == "-" else raw)


# ── probes ───────────────────────────────────────────────────────────────────

def cmd_probe_new(args) -> dict:
    """A project at ``$TMPDIR/dm-probe-<id>/`` whose kinds live in their own namespace
    ``dmprobe<id>``, so nothing it registers can collide with a real project's kinds."""
    tag = uuid.uuid4().hex[:8]
    root = Path(tempfile.gettempdir()).resolve() / f"{PROBE_PREFIX}{tag}"
    ns = f"dmprobe{tag}"
    for family in ("data_schema", "dataset", "project_manifest"):
        (root / "agentic-assets" / family).mkdir(parents=True, exist_ok=True)
    (root / "agentic-assets/project_manifest/project_manifest.json").write_text(
        json.dumps({"schema": 1, "requires": {}, "ns": ns, "entries": []}, indent=2) + "\n")
    project = _call("POST", "/graph/project", {"type": "project", "name": root.name, "fs_storage_mount_path": str(root)})
    return {"project_id": project["id"], "root": str(root), "ns": ns,
            "schemas": str(root / "agentic-assets/data_schema"), "datasets": str(root / "agentic-assets/dataset")}


def _probe_ns(root: Path) -> str:
    manifest = root / "agentic-assets/project_manifest/project_manifest.json"
    if not root.name.startswith(PROBE_PREFIX) or not manifest.is_file():
        raise ValueError(f"{root} is not a probe (make one with probe-new)")
    return json.loads(manifest.read_text())["ns"]


def _namespaces(tree: Path) -> set[str]:
    found = set()
    for doc in tree.rglob(SCHEMA_DOC):
        ns = (json.loads(doc.read_text()) or {}).get("ns")
        if ns:
            found.add(ns)
    return found


def cmd_probe_copy(args) -> dict:
    """Copy schema folders (holding ``data_schema.json``) and dataset folders (holding
    ``dataset.json``) into the probe, then re-namespace them: every ``"ns"`` becomes the probe's and
    every ``--<old ns>--.`` prefix in the copied JSON follows. What the probe proves is the SAME
    files, not a hand-made look-alike."""
    root = Path(args.root).resolve()
    ns = _probe_ns(root)
    copied, old = [], set()
    for src in map(lambda s: Path(s).expanduser().resolve(), args.src):
        if (src / SCHEMA_DOC).is_file():
            family = "data_schema"
        elif (src / DATASET_DOC).is_file():
            family = "dataset"
        else:
            raise ValueError(f"{src} holds neither {SCHEMA_DOC} nor {DATASET_DOC}")
        dest = root / "agentic-assets" / family / src.name
        if dest.exists():
            shutil.rmtree(dest)
        ignore = shutil.ignore_patterns(".flow", *(["examples"] if args.no_rows and family == "dataset" else []))
        shutil.copytree(src, dest, ignore=ignore)
        old |= _namespaces(dest)
        copied.append(str(dest))
    rewritten = 0
    for dest in map(Path, copied):
        for doc in dest.rglob("*.json"):
            text = original = doc.read_text()
            for name in old:
                text = text.replace(f"--{name}--.", f"--{ns}--.")
            if doc.name == SCHEMA_DOC:
                data = json.loads(text)
                if "ns" in data:
                    data["ns"] = ns
                text = json.dumps(data, indent=2, ensure_ascii=False) + "\n"
            if text != original:
                doc.write_text(text)
                rewritten += 1
    return {"root": str(root), "ns": ns, "copied": copied, "renamed_namespaces": sorted(old), "files_rewritten": rewritten}


def cmd_probe_drop(args) -> dict:
    """Delete the probe project with everything under it, then PROVE it is gone: the row answers
    404 and the folder no longer exists. Refuses anything that is not a probe."""
    project = _call("GET", f"/graph/project/{args.project_id}")
    mount = Path((project or {}).get("fs_storage_mount_path") or "")
    if not mount.name.startswith(PROBE_PREFIX):
        raise ValueError(f"project {args.project_id} ({mount}) is not a probe -- refusing to delete it")
    result = _call("POST", f"/graph/project/{args.project_id}/delete-with-children", {"delete_chats": True}) or {}
    try:
        _call("GET", f"/graph/project/{args.project_id}")
        row_gone = False
    except ApiError as exc:
        row_gone = exc.status == 404
    if mount.exists():
        shutil.rmtree(mount, ignore_errors=True)
    # Nothing indexed from the probe may outlive it. The project sweep misses a row now and then (seen
    # once, after a backend restart mid-probe): delete any row still pointing into the probe folder,
    # and say so -- `swept` is never empty silently.
    swept = []
    for family in ("dataset", "data_schema"):
        for row in _call("GET", f"/graph/{family}") or []:
            if str(row.get("asset_ref") or "").startswith(str(mount)):
                _call("DELETE", f"/graph/{family}/{row['id']}")
                swept.append(f"{family}:{row['id']}")
    return {"project_id": args.project_id, "deleted_children": result.get("deleted_children"),
            "row_gone": row_gone, "folder_gone": not mount.exists(), "rows_swept_after": swept}


# ── kinds and values ─────────────────────────────────────────────────────────

def cmd_kind(args) -> dict:
    return {"form": _call("GET", f"/kinds/{quote(args.kind, safe='')}")}


def cmd_check(args) -> dict:
    return _call("POST", f"/kinds/{quote(args.kind, safe='')}/check", {"value": _json(args.value)})


# ── datasets ─────────────────────────────────────────────────────────────────

def _datasets() -> list[dict]:
    return list(_call("GET", "/graph/dataset") or [])


def _dataset(ref: str) -> dict:
    """By id, folder path, or an unambiguous name/title. Ambiguity is an error, never a guess."""
    rows = _datasets()
    path = Path(ref).expanduser()
    if path.is_dir():
        hits = [r for r in rows if r.get("asset_ref") and Path(r["asset_ref"]).resolve() == path.resolve()]
        if not hits:
            raise LookupError(f"no indexed dataset at {path} -- run: flow record index \"{path}\" --types dataset")
        return hits[0]
    hits = [r for r in rows if r.get("id") == ref] or [r for r in rows if ref in (r.get("name"), r.get("title"))]
    if not hits:
        raise LookupError(f"no dataset matches {ref!r}")
    if len(hits) > 1:
        raise LookupError(f"{ref!r} matches {len(hits)} datasets: " + ", ".join(f"{r.get('asset_ref')} ({r['id']})" for r in hits))
    return hits[0]


def _ds(args, action: str, method: str = "POST", body: Any = None) -> Any:
    return _call(method, f"/graph/dataset/{_dataset(args.dataset)['id']}/{action}", body)


def cmd_ds_find(args) -> dict:
    query = f"?project={quote(args.project, safe='')}" if args.project else ""
    return {"kind": args.kind, **(_call("GET", f"/kinds/{quote(args.kind, safe='')}/datasets{query}") or {})}


def cmd_ds_rows(args) -> dict:
    """Every row that fits (each with ``key``, ``id``, ``ref``, ``version``), and the ``problems``."""
    got = _ds(args, "rows", "GET") or {}
    rows = got.get("rows") or []
    return {"count": len(rows), "rows": rows, "problems": got.get("problems") or []}


def cmd_ds_row(args) -> dict:
    return {"row": _ds(args, f"example/{quote(args.key, safe='')}", "GET")}


def cmd_ds_append(args) -> dict:
    rows = _json(args.rows)
    return _ds(args, "append", body={"rows": rows if isinstance(rows, list) else [rows]})


def cmd_ds_put(args) -> dict:
    body = {"key": args.key, "row": _json(args.row)}
    return _ds(args, "put-row", body={**body, "expected": args.expected} if args.expected else body)


def cmd_ds_delete(args) -> dict:
    body = {"key": args.key}
    return _ds(args, "delete-row", body={**body, "expected": args.expected} if args.expected else body)


def cmd_ds_store_ids(args) -> dict:
    return _ds(args, "store-ids", body={})


def cmd_ds_rename(args) -> dict:
    body = {"key": args.key, "new_key": args.new_key}
    return _ds(args, "rename-row", body={**body, "expected": args.expected} if args.expected else body)


def cmd_ds_check(args) -> dict:
    return _ds(args, "check-row", body={"row": _json(args.row)})


def cmd_ds_validate(args) -> dict:
    return _ds(args, "validate", body={})


# ── entry ────────────────────────────────────────────────────────────────────

_DS = ("dataset", {"help": "dataset id, name, title or folder path"})
VERBS: dict[str, tuple] = {
    "probe-new": (cmd_probe_new, []),
    "probe-copy": (cmd_probe_copy, [("root", {}), ("src", {"nargs": "+"}),
                                    ("--no-rows", {"action": "store_true", "help": "leave dataset rows behind"})]),
    "probe-drop": (cmd_probe_drop, [("project_id", {})]),
    "kind": (cmd_kind, [("kind", {})]),
    "check": (cmd_check, [("kind", {}), ("value", {})]),
    "ds-find": (cmd_ds_find, [("kind", {}), ("--project", {"default": "", "help": "only this project's"})]),
    "ds-rows": (cmd_ds_rows, [_DS]),
    "ds-row": (cmd_ds_row, [_DS, ("key", {})]),
    "ds-append": (cmd_ds_append, [_DS, ("rows", {})]),
    "ds-put": (cmd_ds_put, [_DS, ("key", {}), ("row", {}),
                            ("--expected", {"default": "", "help": "the version you read; a newer row refuses"})]),
    "ds-delete": (cmd_ds_delete, [_DS, ("key", {}),
                                  ("--expected", {"default": "", "help": "the version you read; a newer row refuses"})]),
    "ds-store-ids": (cmd_ds_store_ids, [_DS]),
    "ds-rename": (cmd_ds_rename, [_DS, ("key", {}), ("new_key", {}),
                                  ("--expected", {"default": "", "help": "the version you read; a newer row refuses"})]),
    "ds-check": (cmd_ds_check, [_DS, ("row", {})]),
    "ds-validate": (cmd_ds_validate, [_DS]),
}


def main(argv: list[str] | None = None) -> int:
    import argparse  # noqa: PLC0415

    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = parser.add_subparsers(dest="verb", required=True)
    for name, (_fn, params) in VERBS.items():
        sub = subs.add_parser(name)
        for flag, kwargs in params:
            sub.add_argument(flag, **kwargs)
    raw = sys.argv[1:] if argv is None else argv
    args = parser.parse_args([_SHIELD + a if NS_KIND.match(a) else a for a in raw])
    for name, value in vars(args).items():
        if isinstance(value, str) and value.startswith(_SHIELD):
            setattr(args, name, value[len(_SHIELD):])
    try:
        payload = VERBS[args.verb][0](args)
    except ApiError as exc:
        print(json.dumps({"ok": False, "error_code": "API_ERROR", "error": str(exc), "data": exc.data}, default=str))  # noqa: T201
        return 1
    except Exception as exc:  # noqa: BLE001 -- the contract is one JSON object, always
        print(json.dumps({"ok": False, "error_code": type(exc).__name__, "error": str(exc)}))  # noqa: T201
        return 1
    print(json.dumps({"ok": True, **(payload or {})}, default=str))  # noqa: T201 -- the contract IS stdout
    return 0


if __name__ == "__main__":
    sys.exit(main())
