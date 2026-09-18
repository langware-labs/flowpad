"""One-shot migration: every ``SourceItem`` row carries its origin and typed payload, and
every projected message carries its row's origin.

The ingestor now resolves a row by ``(data_source_id, origin_kind, origin_namespace,
origin_key)`` — the resource's ``CloudOrigin`` partitioned by the source that mirrors it.
A row written before that carries only the flat header, so without this pass the next poll
would miss it and mint a twin of every record already ingested.

Pass 1 — rows. Each ``source_item`` row without an origin is lifted through
``flow_sdk.ingest.legacy_lift`` — the same function the ingestor lifts new pages with, so a
migrated row and a freshly ingested one can never disagree. Rows that lift onto one origin
are duplicates (the old key was never unique): the most recently updated survives, ``read``
and ``starred`` are OR-merged into it, and messages pointing at a loser are repointed.

Pass 2 — messages. A ``flow_message`` projected from a row carries ``origin``; before the
triple it had no namespace (read as ``legacy``), and between the triple and this pass it had
an interim one. Each is set to its row's origin, keeping the message's own ``url``.

Pass 3 — conversations. A conversation fed by a source names its ``channel`` and
``channel_source_id``; one projected before those fields existed takes them from its
messages' rows, and only where they are still empty.

A row whose header cannot name an origin (a blank key component) is counted and left alone.
Idempotent: a converted instance reports zeros.

Usage:
    uv run -m flow_sdk.migrations.migration_2026_09_sources_cutover --dry-run
    uv run -m flow_sdk.migrations.migration_2026_09_sources_cutover --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path
from types import SimpleNamespace
from typing import Any

logger = logging.getLogger("migrate.sources_cutover")

ITEM = "source_item"
SOURCE = "data_source"
MESSAGE = "flow_message"
CONVERSATION = "conversation"


@dataclass
class Report:
    rows_lifted: int = 0
    rows_unliftable: int = 0
    duplicates_removed: int = 0
    messages_repointed: int = 0
    messages_reoriginated: int = 0
    conversations_stamped: int = 0
    unliftable_ids: list[str] = field(default_factory=list)

    @property
    def changed(self) -> bool:
        return bool(
            self.rows_lifted
            or self.duplicates_removed
            or self.messages_repointed
            or self.messages_reoriginated
            or self.conversations_stamped
        )


@dataclass
class _Row:
    id: str
    blob: dict[str, Any]
    stamp: str
    dirty: bool = False


def _db_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().db_path)


def _open(db: Path | None = None):
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite

    return open_sqlite(str(db or _db_path()))


def _rows(conn, type_name: str) -> list[_Row]:
    if conn.execute("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'entities'").fetchone() is None:
        return []
    out = []
    for eid, blob, created, updated in conn.execute(
        "SELECT id, data, created_date, updated_date FROM entities WHERE type = ?", (type_name,)
    ):
        try:
            data = json.loads(blob) if blob else {}
        except (TypeError, json.JSONDecodeError):
            continue
        if isinstance(data, dict):
            out.append(_Row(str(eid), data, str(updated or created or "")))
    return out


def _lift(row: _Row, sources: dict[str, SimpleNamespace]) -> tuple[str, str, str] | None:
    """Fill ``origin``, the flat triple and ``data`` on a row that lacks them. The key, or None."""
    from pydantic import ValidationError

    from flow_sdk.ingest.legacy_lift import data_of, origin_of

    blob = row.blob
    if blob.get("origin_key") and blob.get("data"):
        return (blob.get("origin_kind", ""), blob.get("origin_namespace", ""), blob["origin_key"])
    header = SimpleNamespace(**blob)
    source = sources.get(str(blob.get("data_source_id") or ""))
    try:
        origin = origin_of(source, header)
        payload = data_of(source, header, origin)
    except (ValidationError, ValueError):
        return None
    blob["origin"] = origin.model_dump(mode="json")
    blob.update(origin_kind=origin.kind, origin_namespace=origin.namespace, origin_key=origin.key)
    blob["data"] = {"spec_kind": payload.spec_kind, **payload.model_dump(mode="json")}
    row.dirty = True
    return (origin.kind, origin.namespace, origin.key)


def _message_item_id(blob: dict[str, Any]) -> str:
    local = blob.get("origin_local") if isinstance(blob.get("origin_local"), dict) else {}
    return str(blob.get("source_item_id") or local.get("source_item_id") or "")


def migrate(*, dry_run: bool = True, db: Path | None = None) -> Report:
    import flow_sdk.schema.data_spec._kinds as kinds

    kinds.register_builtin_kinds()
    report = Report()
    conn = _open(db)
    try:
        sources = {
            r.id: SimpleNamespace(**{k: r.blob.get(k) for k in ("channel", "provider", "account_key")})
            for r in _rows(conn, SOURCE)
        }

        # ── pass 1: lift, then collapse rows that name one origin ──
        groups: dict[tuple[str, ...], list[_Row]] = defaultdict(list)
        for row in _rows(conn, ITEM):
            key = _lift(row, sources)
            if key is None:
                report.rows_unliftable += 1
                report.unliftable_ids.append(row.id)
                continue
            report.rows_lifted += row.dirty
            groups[(str(row.blob.get("data_source_id") or ""), *key)].append(row)

        survivors: dict[str, _Row] = {}
        doomed: list[str] = []
        for rows in groups.values():
            rows.sort(key=lambda r: (r.stamp, r.id), reverse=True)
            winner, losers = rows[0], rows[1:]
            for loser in losers:
                for flag in ("read", "starred"):
                    if loser.blob.get(flag) and not winner.blob.get(flag):
                        winner.blob[flag] = True
                        winner.dirty = True
                survivors[loser.id] = winner
                doomed.append(loser.id)
            survivors[winner.id] = winner
        report.duplicates_removed = len(doomed)

        # ── pass 2: messages follow their row ──
        messages = []
        for msg in _rows(conn, MESSAGE):
            item_id = _message_item_id(msg.blob)
            row = survivors.get(item_id)
            if row is None:
                continue
            if row.id != item_id:
                msg.blob["source_item_id"] = row.id
                if isinstance(msg.blob.get("origin_local"), dict):
                    msg.blob["origin_local"] = {**msg.blob["origin_local"], "source_item_id": row.id}
                report.messages_repointed += 1
                msg.dirty = True
            messages.append(msg)
            current = msg.blob.get("origin") if isinstance(msg.blob.get("origin"), dict) else None
            target = row.blob["origin"]
            triple = ("kind", "namespace", "key")
            if current is not None and tuple(current.get(k) for k in triple) != tuple(target[k] for k in triple):
                msg.blob["origin"] = {**{k: target[k] for k in triple}, "url": current.get("url") or None}
                report.messages_reoriginated += 1
                msg.dirty = True

        # ── pass 3: conversations name their channel and source ──
        stamps: dict[str, dict[str, str]] = {}
        for msg in messages:
            conversation_id = str(msg.blob.get("conversation_id") or "")
            row = survivors[_message_item_id(msg.blob)] if _message_item_id(msg.blob) in survivors else None
            if conversation_id and row is not None:
                stamps.setdefault(conversation_id, {
                    "channel": row.blob["origin"]["kind"],
                    "channel_source_id": str(row.blob.get("data_source_id") or ""),
                })
        conversations = []
        for conv in _rows(conn, CONVERSATION):
            for name, value in stamps.get(conv.id, {}).items():
                if value and not conv.blob.get(name):
                    conv.blob[name] = value
                    conv.dirty = True
            if conv.dirty:
                report.conversations_stamped += 1
                conversations.append(conv)

        if not dry_run:
            dead = set(doomed)
            for row in {id(r): r for r in survivors.values()}.values():
                if row.dirty and row.id not in dead:
                    conn.execute("UPDATE entities SET data = ? WHERE id = ?", (json.dumps(row.blob), row.id))
            for msg in (*messages, *conversations):
                if msg.dirty:
                    conn.execute("UPDATE entities SET data = ? WHERE id = ?", (json.dumps(msg.blob), msg.id))
            for eid in doomed:
                conn.execute("DELETE FROM entities WHERE id = ?", (eid,))
                conn.execute("DELETE FROM relationships WHERE from_id = ? OR to_id = ?", (eid, eid))
            conn.commit()
        return report
    finally:
        conn.close()


def _print(report: Report, dry_run: bool) -> None:
    verb = "would" if dry_run else "did"
    if not report.changed and not report.rows_unliftable:
        print("sources cutover: every row and message already carries its origin.")  # noqa: T201
        return
    print(  # noqa: T201
        f"sources cutover ({verb}): lift {report.rows_lifted} row(s), remove {report.duplicates_removed} duplicate(s), "
        f"repoint {report.messages_repointed} message(s), re-origin {report.messages_reoriginated} message(s)."
    )
    if report.rows_unliftable:
        print(f"  {report.rows_unliftable} row(s) name no origin and were left as they are.")  # noqa: T201


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--dry-run", action="store_true", default=True)
    mode.add_argument("--apply", action="store_true")
    args = parser.parse_args(argv)
    dry_run = not args.apply
    _print(migrate(dry_run=dry_run), dry_run)
    return 0


if __name__ == "__main__":
    sys.exit(main())
