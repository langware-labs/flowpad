"""One-time migration: every stored ``SourceItem`` carries its account-free identity
``(data_source_id, item_scope, item_key)`` and a digest over its payload.

NOT APPROVED — written and tested on fixture DBs only. It is applied to a real instance
only after the user approves the dry-run numbers from a prod copy.

Step 5 (``SourceItem identity = (data_source_id, item_scope, item_key)``) moved the natural
key and the change digest; rows written before it resolve through
``TypeInfo.legacy_natural_key`` and their header digest is accepted as unchanged. This pass
brings every stored row onto the new form so both fallbacks can be deleted later.

Phase 1 — rows, by rowid, ``batch_size`` (500) per transaction:
  1. ``data`` missing → lifted through ``flow_sdk.ingest.envelope_lift`` (as the 2026-09
     cutover did). A row whose header names no origin is counted and left alone.
  2. ``item_scope`` / ``item_key`` missing → key = the origin key; scope = ``scope_in(origin,
     <the source's account>)``, with the source's own row id / provider / kind also read as
     "no container". A single-part namespace that is NOT the current account on a source that
     HAS one was minted under a former account (a flat-lifted row) → scope ``""``, so it
     collides with — and merges into — its twin from after the account change.
  3. ``content_digest`` re-computed over ``SourceItemSpec.digest_view`` (the payload).
  Writes are raw SQL on the row's JSON: no save hooks, no FTS, no broadcast, no tags.
  The flat header and ``origin_*`` are NOT dropped (readers move in step 7, deletion is step 8),
  and payload references (conversation / in_reply_to / sender / attachment origins) are NOT
  rewritten — sources still mint account-ful namespaces there, so stripping them here would
  flip every digest on the next poll.

Phase 2 — collisions on the new identity, one transaction: the OLDEST row (``created_date``)
survives; ``read``/``starred``/``sent_by_us`` are OR-ed, ``reactions`` unioned, and the newest
payload by item time is kept (the survivor adopts that row's content fields). Every reference to
a loser — any non-dataset entity's JSON (``flow_message.source_item_id``,
``origin_local.source_item_id`` …) and ``relationships`` rows — is repointed, the loser's FTS
row is dropped (moved to the survivor when its content was adopted), and the loser deleted.
Each merge is logged.

Resumable: the last committed rowid is kept in a progress file next to the DB (apply only).
Idempotent: a migrated DB reports zeros. Dry run executes everything in ONE transaction and
rolls it back, so its numbers are exact — run it on a copy or a stopped instance (it holds the
write lock while it runs).

Usage:
    uv run python -m flow_sdk.migrations.migration_2026_10_source_item_identity --db PATH --dry-run
    uv run python -m flow_sdk.migrations.migration_2026_10_source_item_identity --db PATH --apply
"""
from __future__ import annotations

import argparse
import json
import logging
import re
import sqlite3
import sys
import time
from collections import defaultdict
from pathlib import Path
from types import SimpleNamespace
from typing import Any, Callable, Optional

logger = logging.getLogger("migrate.source_item_identity")

ITEM = "source_item"
SOURCE = "data_source"
#: Frozen on purpose: dataset rows were labelled against the item they name.
FROZEN_TYPES = frozenset({"dataset"})
LOCAL_FLAGS = ("read", "starred", "sent_by_us")
BATCH_SIZE = 500
_UUID = re.compile(r"[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}")


def _registered() -> None:
    import flow_sdk.schema.data_spec._kinds as kinds  # noqa: PLC0415

    kinds.register_builtin_kinds()


def _content_fields() -> frozenset[str]:
    """What a merge survivor adopts from the row whose payload is newest: the spec's fields plus
    the identity/derived copies — never local state, ids or dates."""
    from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec  # noqa: PLC0415

    return frozenset(SourceItemSpec.model_fields) | {
        "origin_kind", "origin_namespace", "origin_key", "item_key", "item_scope", "content_digest", "name",
    } - {"data_source_id"}


def default_progress_path(db_path: Path) -> Path:
    return Path(str(db_path) + ".source_item_identity.progress.json")


# ── report ─────────────────────────────────────────────────────────────────


def _new_report() -> dict[str, Any]:
    return {
        "dry_run": True,
        "rows_total": 0,
        "rows_seen": 0,
        "lifted": 0,
        "unliftable": 0,
        "scoped_keyed": 0,
        "scoped_by_former_account": 0,
        "redigested": 0,
        "undigestable": 0,
        "collision_groups": 0,
        "rows_merged_away": 0,
        "references_repointed": 0,
        "messages_repointed": 0,
        "relationships_repointed": 0,
        "survivors_with_two_messages": 0,
        "merges": [],
        "unliftable_ids": [],
        "per_source": {},
        "resumed_from_rowid": 0,
        "elapsed_s": 0.0,
    }


def _bump(report: dict, source_id: str, name: str, n: int = 1) -> None:
    report[name] += n
    per = report["per_source"].setdefault(source_id or "(none)", defaultdict(int))
    per[name] += n


def _note_scope(report: dict, source_id: str, namespace: str, scope: str) -> None:
    """A few namespace → scope samples per source, for reviewing the dry run."""
    per = report["per_source"].setdefault(source_id or "(none)", defaultdict(int))
    samples = per.setdefault("scope_samples", {})  # type: ignore[call-overload]
    if namespace not in samples and len(samples) < 5:
        samples[namespace] = scope


# ── per-row (phase 1) ──────────────────────────────────────────────────────


def _sources(conn: sqlite3.Connection) -> dict[str, SimpleNamespace]:
    out = {}
    for eid, blob in conn.execute("SELECT id, data FROM entities WHERE type = ?", (SOURCE,)):
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            out[str(eid)] = SimpleNamespace(
                id=str(eid), **{k: str(data.get(k) or "") for k in ("channel", "provider", "account_key")}
            )
    return out


def scope_for(origin: Any, source: Optional[SimpleNamespace]) -> tuple[str, bool]:
    """``(scope, minted_under_a_former_account)`` for a stored origin of ``source``."""
    from flow_sdk.sources.base import scope_in  # noqa: PLC0415

    account = source.account_key if source is not None else ""
    namespace = origin.namespace
    home = {origin.kind, *(v for v in (account, getattr(source, "id", ""), getattr(source, "provider", "")) if v)}
    if namespace in home:
        return "", False
    if account and "/" not in namespace:
        # A flat-lifted row's namespace IS the account it was read as; this one is not today's.
        return "", True
    return scope_in(origin, account), False


def _lift(blob: dict, source: Optional[SimpleNamespace]) -> Optional[bool]:
    """Fill ``origin`` / ``data`` (+ the flat triple) where missing. True = changed, False =
    already there, None = names no origin."""
    from pydantic import ValidationError  # noqa: PLC0415

    from flow_sdk.ingest.envelope_lift import data_of, origin_of  # noqa: PLC0415
    from flow_sdk.schema.data_spec.spec import spec_tag  # noqa: PLC0415
    from flow_sdk.sources.values.origin import CloudOrigin  # noqa: PLC0415

    if blob.get("data") and blob.get("origin"):
        return False
    header = SimpleNamespace(**blob)
    try:
        origin = CloudOrigin.model_validate(blob["origin"]) if blob.get("origin") else origin_of(source, header)
        payload = data_of(source, header, origin)
    except (ValidationError, ValueError, TypeError):
        return None
    blob["origin"] = origin.model_dump(mode="json")
    blob.update(origin_kind=origin.kind, origin_namespace=origin.namespace, origin_key=origin.key)
    if not blob.get("data"):
        blob["data"] = {"spec_kind": spec_tag(payload), **payload.model_dump(mode="json")}
    return True


def _spec(blob: dict):
    from flow_sdk.schema.data_spec.source_item_spec import SourceItemSpec  # noqa: PLC0415

    return SourceItemSpec.model_validate({k: blob[k] for k in SourceItemSpec.model_fields if k in blob})


def _digest(blob: dict) -> Optional[str]:
    from flow_sdk.ingest.digest import content_digest  # noqa: PLC0415

    try:
        return content_digest(_spec(blob))
    except Exception:  # noqa: BLE001 — a row the spec cannot read keeps its digest; counted
        return None


def _migrate_row(blob: dict, sources: dict[str, SimpleNamespace], report: dict) -> bool:
    """Bring one row's JSON onto the new form in place. True when it changed."""
    from flow_sdk.sources.values.origin import CloudOrigin  # noqa: PLC0415

    sid = str(blob.get("data_source_id") or "")
    source = sources.get(sid)
    lifted = _lift(blob, source)
    if lifted is None:
        _bump(report, sid, "unliftable")
        return False
    changed = bool(lifted)
    if lifted:
        _bump(report, sid, "lifted")
    if "item_scope" not in blob or not blob.get("item_key"):
        origin = CloudOrigin.model_validate(blob["origin"])
        scope, former = scope_for(origin, source)
        blob["item_scope"], blob["item_key"] = scope, origin.key
        _bump(report, sid, "scoped_keyed")
        if former:
            _bump(report, sid, "scoped_by_former_account")
        _note_scope(report, sid, origin.namespace, scope)
        changed = True
    digest = _digest(blob)
    if digest is None:
        _bump(report, sid, "undigestable")
    elif digest != blob.get("content_digest"):
        blob["content_digest"] = digest
        _bump(report, sid, "redigested")
        changed = True
    return changed


def _phase_rows(conn, sources, report, *, start: int, batch_size: int, dry_run: bool,
                progress_path: Path, stop_after_batches: Optional[int]) -> None:
    last, batches = start, 0
    while True:
        rows = conn.execute(
            "SELECT rowid, id, data FROM entities WHERE type = ? AND rowid > ? ORDER BY rowid LIMIT ?",
            (ITEM, last, batch_size),
        ).fetchall()
        if not rows:
            return
        if not dry_run:
            conn.execute("BEGIN IMMEDIATE")
        for rowid, eid, raw in rows:
            last = rowid
            report["rows_seen"] += 1
            try:
                blob = json.loads(raw) if raw else None
            except (TypeError, json.JSONDecodeError):
                blob = None
            if not isinstance(blob, dict):
                _bump(report, "", "unliftable")
                report["unliftable_ids"].append(str(eid))
                continue
            before = report["unliftable"]
            if _migrate_row(blob, sources, report):
                conn.execute("UPDATE entities SET data = ? WHERE id = ?", (json.dumps(blob), eid))
            elif report["unliftable"] > before and len(report["unliftable_ids"]) < 200:
                report["unliftable_ids"].append(str(eid))
        if not dry_run:
            conn.execute("COMMIT")
            progress_path.write_text(json.dumps({"phase": "rows", "last_rowid": last}))
        batches += 1
        if stop_after_batches is not None and batches >= stop_after_batches:
            raise _Stopped(last)


class _Stopped(Exception):
    """Raised by the test hook to simulate a process dying between batches."""


# ── collisions (phase 2) ───────────────────────────────────────────────────


def _item_time(blob: dict) -> str:
    from flow_sdk.utils.serialization import iso_to_utc  # noqa: PLC0415

    value = None
    try:
        data = _spec(blob).data
        value = data.item_at if data is not None else None
    except Exception:  # noqa: BLE001
        value = None
    value = value or blob.get("occurred_at")
    parsed = iso_to_utc(value) if value else None
    return parsed.isoformat() if parsed is not None else ""


def _canon(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"))


def _has_table(conn, name: str) -> bool:
    return conn.execute("SELECT 1 FROM sqlite_master WHERE name = ?", (name,)).fetchone() is not None


def _phase_collisions(conn, report, *, dry_run: bool) -> None:
    groups = conn.execute(
        "SELECT group_concat(id, ',') FROM entities WHERE type = ? "
        "AND json_extract(data, '$.item_scope') IS NOT NULL "
        "AND coalesce(json_extract(data, '$.item_key'), '') != '' "
        "GROUP BY json_extract(data, '$.data_source_id'), json_extract(data, '$.item_scope'), "
        "json_extract(data, '$.item_key') HAVING count(*) > 1",
        (ITEM,),
    ).fetchall()
    if not groups:
        return
    content = _content_fields()
    if not dry_run:
        conn.execute("BEGIN IMMEDIATE")
    winner_of: dict[str, str] = {}
    fts = _has_table(conn, "entities_fts")
    for (ids,) in groups:
        rows = [
            (str(eid), str(created or ""), json.loads(raw))
            for eid, created, raw in conn.execute(
                f"SELECT id, created_date, data FROM entities WHERE id IN ({','.join('?' * len(ids.split(',')))})",
                ids.split(","),
            )
        ]
        rows.sort(key=lambda r: (r[1], r[0]))
        (wid, _, winner), losers = rows[0], rows[1:]
        sid = str(winner.get("data_source_id") or "")
        _bump(report, sid, "collision_groups")
        newest_id, newest, newest_at = wid, winner, _item_time(winner)
        reactions = {_canon(r): r for r in winner.get("reactions") or []}
        for lid, _, loser in losers:
            for flag in LOCAL_FLAGS:
                if loser.get(flag) and not winner.get(flag):
                    winner[flag] = True
            for r in loser.get("reactions") or []:
                reactions.setdefault(_canon(r), r)
            at = _item_time(loser)
            if at > newest_at:
                newest_id, newest, newest_at = lid, loser, at
            winner_of[lid] = wid
            _bump(report, sid, "rows_merged_away")
        if reactions or "reactions" in winner:
            winner["reactions"] = list(reactions.values())
        if newest_id != wid:
            for name in content:
                if name in newest:
                    winner[name] = newest[name]
                else:
                    winner.pop(name, None)
        conn.execute("UPDATE entities SET data = ? WHERE id = ?", (json.dumps(winner), wid))
        if fts:
            if newest_id != wid:
                conn.execute("DELETE FROM entities_fts WHERE entity_id = ?", (wid,))
                conn.execute("UPDATE entities_fts SET entity_id = ? WHERE entity_id = ?", (wid, newest_id))
            for lid, _, _ in losers:
                conn.execute("DELETE FROM entities_fts WHERE entity_id = ?", (lid,))
        merge = {"survivor": wid, "merged": [lid for lid, _, _ in losers], "payload_from": newest_id, "source": sid}
        report["merges"].append(merge)
        logger.info("source_item merge: %s", merge)

    _repoint(conn, report, winner_of)
    conn.executemany("DELETE FROM entities WHERE id = ?", [(lid,) for lid in winner_of])
    if not dry_run:
        conn.execute("COMMIT")


def _repoint(conn, report: dict, winner_of: dict[str, str]) -> None:
    """Every reference to a loser now names its survivor — one pass over non-item entities."""
    if _has_table(conn, "relationships"):
        for column in ("from_id", "to_id"):
            for lid, wid in winner_of.items():
                n = conn.execute(f"UPDATE relationships SET {column} = ? WHERE {column} = ?", (wid, lid)).rowcount
                report["relationships_repointed"] += n
                report["references_repointed"] += n
    survivors_with_message: dict[str, int] = defaultdict(int)
    for eid, type_name, raw in conn.execute(
        "SELECT id, type, data FROM entities WHERE type != ?", (ITEM,)
    ).fetchall():
        if type_name == "flow_message" and raw:
            try:
                item_id = str(json.loads(raw).get("source_item_id") or "")
            except (TypeError, json.JSONDecodeError, AttributeError):
                item_id = ""
            survivor = winner_of.get(item_id, item_id)
            if survivor in winner_of.values():
                survivors_with_message[survivor] += 1
        if type_name in FROZEN_TYPES or not raw:
            continue
        hits = {m for m in _UUID.findall(raw) if m in winner_of}
        if not hits:
            continue
        for lid in hits:
            raw = raw.replace(lid, winner_of[lid])
        conn.execute("UPDATE entities SET data = ? WHERE id = ?", (raw, eid))
        report["references_repointed"] += 1
        if type_name == "flow_message":
            report["messages_repointed"] += 1
    report["survivors_with_two_messages"] = sum(1 for n in survivors_with_message.values() if n > 1)


# ── entry ──────────────────────────────────────────────────────────────────


def migrate(
    db_path: str | Path,
    *,
    dry_run: bool,
    batch_size: int = BATCH_SIZE,
    progress_path: Optional[Path] = None,
    stop_after_batches: Optional[int] = None,
) -> dict[str, Any]:
    """Run the migration on ``db_path``; the report dict. ``stop_after_batches`` is a test hook
    that simulates a stop mid-pass (raises after that many committed batches)."""
    _registered()
    started = time.monotonic()
    db_path = Path(db_path)
    progress_path = progress_path or default_progress_path(db_path)
    report = _new_report()
    report["dry_run"] = dry_run
    conn = sqlite3.connect(str(db_path), isolation_level=None)
    try:
        if not _has_table(conn, "entities"):
            return report
        start = 0
        if not dry_run and progress_path.exists():
            try:
                start = int(json.loads(progress_path.read_text()).get("last_rowid") or 0)
            except (ValueError, json.JSONDecodeError, AttributeError):
                start = 0
        report["resumed_from_rowid"] = start
        report["rows_total"] = conn.execute("SELECT count(*) FROM entities WHERE type = ?", (ITEM,)).fetchone()[0]
        if dry_run:
            conn.execute("BEGIN IMMEDIATE")
        try:
            sources = _sources(conn)
            _phase_rows(conn, sources, report, start=start, batch_size=batch_size, dry_run=dry_run,
                        progress_path=progress_path, stop_after_batches=stop_after_batches)
            _phase_collisions(conn, report, dry_run=dry_run)
        finally:
            if conn.in_transaction:
                conn.execute("ROLLBACK")
        if not dry_run:
            progress_path.unlink(missing_ok=True)
    finally:
        conn.close()
        report["elapsed_s"] = round(time.monotonic() - started, 3)
        report["per_source"] = {k: dict(v) for k, v in report["per_source"].items()}
    return report


COUNTS = (
    "rows_total", "lifted", "unliftable", "scoped_keyed", "scoped_by_former_account", "redigested",
    "undigestable", "collision_groups", "rows_merged_away", "references_repointed", "messages_repointed",
    "relationships_repointed", "survivors_with_two_messages",
)


def format_report(report: dict, out: Callable[[str], Any] = print) -> None:
    verb = "DRY RUN (nothing written)" if report["dry_run"] else "APPLIED"
    out(f"source_item identity migration — {verb}")
    for name in COUNTS:
        out(f"  {name:28} {report[name]}")
    if report["resumed_from_rowid"]:
        out(f"  resumed after rowid {report['resumed_from_rowid']}")
    out("  per data source:")
    for sid, counts in sorted(report["per_source"].items()):
        samples = counts.pop("scope_samples", None)
        out(f"    {sid}: " + ", ".join(f"{k}={v}" for k, v in sorted(counts.items())))
        if samples:
            out("      namespace → scope: " + "; ".join(f"{ns!r} → {sc!r}" for ns, sc in samples.items()))
        if samples is not None:
            counts["scope_samples"] = samples
    for merge in report["merges"][:50]:
        out(f"  merge: {merge}")
    if len(report["merges"]) > 50:
        out(f"  … {len(report['merges']) - 50} more merges")
    out(f"  elapsed {report['elapsed_s']}s")


def main(argv: Optional[list[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="SourceItem identity migration (NOT APPROVED — dry run first).")
    parser.add_argument("--db", required=True, type=Path, help="Path to the instance's sqlite DB (use a COPY)")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--dry-run", action="store_true")
    mode.add_argument("--apply", action="store_true")
    parser.add_argument("--json", action="store_true", help="Print the full report as JSON")
    args = parser.parse_args(argv)
    if not args.db.exists():
        print(f"no such DB: {args.db}", file=sys.stderr)  # noqa: T201
        return 2
    report = migrate(args.db, dry_run=not args.apply)
    if args.json:
        print(json.dumps(report, indent=2, default=str))  # noqa: T201
    else:
        format_report(report)
    return 0


if __name__ == "__main__":
    sys.exit(main())
