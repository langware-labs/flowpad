#!/usr/bin/env python3
"""Data-source mechanics for the connect-data-source skill. One JSON object per call.

**Why this exists instead of `curl`.** There is no `flow` verb for data sources,
and the backend's cookie gate rejects an un-gated request with a 403 — there is
no loopback exemption. `discover_port()` + `local_get`/`local_post` from
`flow_sdk.cli.commands._common` are the gate-safe path, so every call goes
through them and none builds a bare request.

**Why a script at all.** The model's job is mapping a person's words onto a
provider and a config. Everything after that is mechanical and must be identical
every time — so it lives here, where it can be read and tested, rather than being
re-improvised as a shell one-liner per run.

Output contract: exactly one JSON object on stdout. `{"ok": true, ...}` on
success; `{"ok": false, "error_code": ..., "error": ...}` on failure, exit 1.
Nothing else is ever printed — a caller parses stdout whole.
"""
from __future__ import annotations

import argparse
import json
import sys
import time
from functools import lru_cache
from typing import Any


@lru_cache(maxsize=1)
def _api() -> str:
    """Base URL, resolved once. `discover_port` reads `server.json` off disk and
    the port cannot change inside one invocation — `observe` alone would have
    re-read it three times per loop iteration."""
    from flow_sdk.cli.commands._common import discover_port  # noqa: PLC0415

    return f"http://127.0.0.1:{discover_port()}/api/v1"


def _envelope(resp) -> Any:
    """The SUCCESS envelope's `data`, or a described failure.

    A body that is not JSON is the cookie gate's HTML 403, which used to surface
    from here as a bare `JSONDecodeError` — unactionable, and stdout JSON is the
    only evidence this skill's caller gets. `bad_response_message` is the same
    sentence the CLI shows for it.
    """
    from flow_sdk.cli.commands._common import bad_response_message  # noqa: PLC0415

    try:
        body = resp.json() or {}
    except ValueError:
        # RuntimeError, not SystemExit: `main` turns an Exception into the
        # one-JSON-object contract, and a BaseException would escape it.
        raise RuntimeError(bad_response_message(resp))
    return body.get("data")


def _get(path: str, **params: Any) -> Any:
    """GET a graph path. `params` are FILTERED SERVER-SIDE.

    The list routes parse a `filter` JSON param and honour a top-level `limit`,
    so asking for one source's rows costs one source's rows. Pulling the whole
    collection and filtering here would scale with everything the instance has
    ever ingested — and `observe` reads on a loop.
    """
    from urllib.parse import urlencode  # noqa: PLC0415

    from flow_sdk.cli.commands._common import local_get  # noqa: PLC0415

    limit = params.pop("limit", None)
    query = {}
    if params:
        query["filter"] = json.dumps(params)
    if limit is not None:
        query["limit"] = str(limit)
    url = f"{_api()}{path}" + (f"?{urlencode(query)}" if query else "")
    return _envelope(local_get(url))


def _post(path: str, body: dict | None = None) -> Any:
    from flow_sdk.cli.commands._common import local_post  # noqa: PLC0415

    return _envelope(local_post(f"{_api()}{path}", json=body or {}))


#: Ceiling for a "how many landed" read. High enough that a normal source is
#: counted exactly, low enough that the observe loop never drags a corpus.
COUNT_CEILING = 500


def _sources() -> list[dict]:
    # Unfiltered on purpose: `_one` needs the whole set to detect an ambiguous
    # name, and this table has one row per configured source.
    return list(_get("/graph/data_source") or [])


def _one(ref: str) -> dict:
    """A source by id, or by an unambiguous name/provider match.

    Ambiguity is an error, never a guess: acting on the wrong source is worse
    than asking which one.
    """
    rows = _sources()
    exact = [r for r in rows if r.get("id") == ref]
    if exact:
        return exact[0]
    needle = ref.strip().lower()
    hits = [r for r in rows if needle in str(r.get("name") or "").lower() or needle == str(r.get("provider") or "").lower()]
    if not hits:
        raise LookupError(f"no data source matches {ref!r}")
    if len(hits) > 1:
        raise LookupError(f"{ref!r} matches {len(hits)}: " + ", ".join(f"{r.get('name')} ({r.get('id')})" for r in hits))
    return hits[0]


def _cursors(source_id: str) -> list[dict]:
    return list(_get("/graph/data_source_cursor", data_source_id=source_id) or [])


def _items(source_id: str, limit: int = 20) -> list[dict]:
    return list(_get("/graph/source_item", data_source_id=source_id, limit=limit) or [])


def _item_count(source_id: str) -> int:
    """How many records this source has produced.

    Bounded rather than unbounded: the gates only ever ask "did it grow", and an
    exact count of a large corpus is not worth transferring on a poll loop.
    """
    return len(_items(source_id, limit=COUNT_CEILING))


# ── verbs ────────────────────────────────────────────────────────────────

def cmd_specs(args) -> dict:
    """What source types are installed. NEVER work from a memorised list."""
    return {
        "specs": [
            {
                "name": s.get("name"),
                "title": s.get("title"),
                "description": s.get("description"),
                "runtime": s.get("runtime"),
                "reflect": s.get("reflect") or [],
                "auth": s.get("auth"),
                "setup_wiki": s.get("setup_wiki") or "",
                "config_schema": s.get("config_schema") or {},
            }
            for s in (_get("/graph/data_source_spec") or [])
        ]
    }


def cmd_list(args) -> dict:
    rows = _sources()
    if args.provider:
        rows = [r for r in rows if r.get("provider") == args.provider]
    return {
        "sources": [
            {k: r.get(k) for k in ("id", "name", "provider", "status", "health", "error_code", "segment_count", "last_synced_at")}
            for r in rows
        ]
    }


def cmd_create(args) -> dict:
    """Create a source, then READ IT BACK and diff.

    The create route silently drops any key it does not recognise — a misspelled
    field returns 200 with the value missing. So the evidence for the setup gate
    is the read-back, never the 201.
    """
    payload = json.loads(sys.stdin.read() if args.json == "-" else args.json)
    payload.setdefault("status", "new")
    created = _post("/graph/data_source", payload) or {}
    source_id = created.get("id")
    if not source_id:
        raise RuntimeError("create returned no id")
    row = _get(f"/graph/data_source/{source_id}") or {}
    dropped = [k for k, v in payload.items() if k != "status" and row.get(k) != v]
    return {
        "id": source_id,
        "typeid": f"data_source-{source_id}",
        "status": row.get("status"),
        "applied": {k: row.get(k) for k in payload if k != "status"},
        "dropped": dropped,
    }


def cmd_verify(args) -> dict:
    """Verify, and say WHICH layer actually ran.

    `ready: true` frequently means nothing was checked — the connection probe
    passes when there is no channel or no probe registered, and the setup check
    passes when the driver has no verify verb at all.
    """
    source = _one(args.source)
    out = _post(f"/graph/data_source/{source['id']}/verify") or {}
    return {
        "id": source["id"],
        "ready": out.get("ready"),
        "layer": out.get("layer"),
        "detail": out.get("detail") or "",
        "pending": out.get("pending") or [],
        "status": out.get("status"),
        "proves": "a credential or setup check ran" if out.get("layer") else "nothing was checked — the test gate is the real proof",
    }


def cmd_poll(args) -> dict:
    """Make it due. This does NOT sync — never report it as if it did."""
    source = _one(args.source)
    out = _post(f"/graph/data_source/{source['id']}/poll_now") or {}
    return {"id": source["id"], "status": out.get("status"), "detail": out.get("detail"), "proves": "nothing yet — run `observe`"}


def cmd_observe(args) -> dict:
    """Watch until items land, the cursor advances, or the budget runs out.

    THE test gate's evidence producer, and the only place a wait loop exists.
    The heartbeat ticks once a minute by design, so this samples rather than
    hurrying it; the budget is never widened to make a run pass.
    """
    source = _one(args.source)
    sid = source["id"]
    before = _item_count(sid)
    deadline = time.monotonic() + args.wait
    row: dict = source
    while True:
        row = _get(f"/graph/data_source/{sid}") or {}
        cursors = _cursors(sid)
        count = _item_count(sid)
        advanced = any(c.get("last_synced_at") for c in cursors)
        if count > before:
            outcome = "items"
            break
        if advanced and row.get("health") == "ok":
            outcome = "empty_but_healthy"
            break
        if time.monotonic() >= deadline:
            outcome = "stalled"
            break
        time.sleep(args.interval)
    return {
        "id": sid,
        "outcome": outcome,
        "items": count,
        "items_before": before,
        "health": row.get("health"),
        "error_code": row.get("error_code"),
        "error_detail": row.get("error_detail"),
        "cursors": [{k: c.get(k) for k in ("segment_key", "health", "error_code", "error_detail", "last_synced_at", "consecutive_failures")} for c in cursors],
        "means": {
            "items": "records landed — the source works",
            "empty_but_healthy": "it synced and found nothing new. Not a failure: the window or the digest gate. Check window_days before believing otherwise",
            "stalled": "the cursor never advanced — read health/error_code and hand to debug",
        }[outcome],
    }


def cmd_snapshot(args) -> dict:
    """Source + cursors + counts, BEFORE anything is poked.

    `poll_now` clears health, error_code and error_detail together, so polling
    first destroys the only evidence of why a source parked.
    """
    source = _one(args.source)
    sid = source["id"]
    return {
        "source": {k: source.get(k) for k in ("id", "name", "provider", "status", "health", "error_code", "error_detail", "setup_detail", "segment_count", "poll_interval_seconds", "window_days", "reflect", "reflect_into", "required_capabilities", "last_synced_at", "verified_at", "next_poll_at")},
        "cursors": [{k: c.get(k) for k in ("segment_key", "segment_label", "health", "error_code", "error_detail", "last_synced_at", "consecutive_failures")} for c in _cursors(sid)],
        "item_count": _item_count(sid),
    }


def cmd_items(args) -> dict:
    source = _one(args.source)
    rows = _items(source["id"], limit=args.limit)
    return {
        "id": source["id"],
        "count": len(rows),
        "items": [{k: r.get(k) for k in ("external_id", "name", "kind", "segment_key", "occurred_at")} for r in rows],
    }


def cmd_delete(args) -> dict:
    """Destructive: cascades cursors AND every record. Requires --yes."""
    if not args.yes:
        raise RuntimeError("refusing to delete without --yes (this also deletes every record it ingested)")
    from flow_sdk.cli.commands._common import local_request  # noqa: PLC0415

    source = _one(args.source)
    # `local_request`, not a bare `requests.delete`: the cookie gate has no path
    # and no loopback exemption, so a hand-built call takes the gate's 403 HTML
    # while every other verb here works.
    resp = local_request("DELETE", f"{_api()}/graph/data_source/{source['id']}", timeout=30)
    return {"id": source["id"], "deleted": resp.ok}


VERBS = {
    "specs": (cmd_specs, []),
    "list": (cmd_list, [("--provider", {})]),
    "create": (cmd_create, [("json", {"help": "JSON payload, or - for stdin"})]),
    "verify": (cmd_verify, [("source", {})]),
    "poll": (cmd_poll, [("source", {})]),
    "observe": (cmd_observe, [("source", {}), ("--wait", {"type": int, "default": 150}), ("--interval", {"type": int, "default": 10})]),
    "snapshot": (cmd_snapshot, [("source", {})]),
    "items": (cmd_items, [("source", {}), ("--limit", {"type": int, "default": 20})]),
    "delete": (cmd_delete, [("source", {}), ("--yes", {"action": "store_true"})]),
}


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    subs = parser.add_subparsers(dest="verb", required=True)
    for name, (_fn, params) in VERBS.items():
        sub = subs.add_parser(name)
        for flag, kwargs in params:
            sub.add_argument(flag, **kwargs)
    args = parser.parse_args()

    try:
        payload = VERBS[args.verb][0](args)
    except Exception as exc:  # noqa: BLE001 — the contract is a JSON object, always
        print(json.dumps({"ok": False, "error_code": type(exc).__name__, "error": str(exc)}))
        return 1
    print(json.dumps({"ok": True, **payload}, default=str))
    return 0


if __name__ == "__main__":
    sys.exit(main())
