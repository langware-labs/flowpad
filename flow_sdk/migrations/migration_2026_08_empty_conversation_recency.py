"""One-shot repair: give message-less Conversations back their real recency.

``project_pointers_to_entity`` derives a conversation's recency as
``max(message.updated_date)``. For a conversation with NO messages that max was
empty and the code fell back to ``datetime.now()`` — stamping ``updated_date``
with the moment of the sync rather than anything the conversation had actually
done. Because ``updated_date`` is the Inbox sort key
(``compareConversationsByRecency``), every catch-up that touched a message-less
conversation promoted it to the top of the Inbox and buried genuinely recent
mail underneath. One reported instance had 30+ empty rows restamped into a
single sweep band, pushing a real message from that morning to rank 36.

The fallback is fixed at the source (empty ⇒ ``created_date``), and a repaired
row is produced naturally the next time a conversation is projected. But an
already-corrupted row is only re-projected when something happens to touch it,
which for a quiet conversation may be never — so the rows corrupted before the
fix need this one-shot pass.

The rule applied here is exactly what the fixed projection now computes:

    message_count == 0  ⇒  updated_date = created_date

Idempotent: a row already satisfying it is skipped, so re-running is a no-op.
Conversations that HAVE messages are never touched — their recency is derived
from real message clocks and is correct.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_08_empty_conversation_recency
    uv run -m flow_sdk.migrations.migration_2026_08_empty_conversation_recency --apply
"""

from __future__ import annotations

import argparse
import json
import logging
import sys

from flow_sdk.builtin.conversation import Conversation

logger = logging.getLogger(__name__)


def _repair(dry_run: bool) -> dict[str, int]:
    """Reset ``updated_date`` to ``created_date`` for every empty conversation.

    Operates directly on SQLite: ``updated_date`` / ``created_date`` are real
    columns (not blob fields), and re-saving through the entity model would run
    the driver's own clock handling on a row whose whole problem is a wrong
    clock. A column UPDATE states the intent exactly.
    """
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.instance_settings import get_instance_settings

    counts = {"candidates": 0, "repaired": 0, "skipped": 0}
    conn = open_sqlite(get_instance_settings().db_path)
    try:
        # The pure-column test is pushed into SQL, so an already-correct row
        # costs neither a JSON parse nor a resident blob — on a real inbox the
        # vast majority of rows are already correct and never reach Python.
        candidates = conn.execute(
            "SELECT id, created_date, updated_date, data FROM entities"
            " WHERE type = ? AND created_date IS NOT NULL AND updated_date <> created_date",
            (Conversation.get_type(),),
        ).fetchall()
        repairs: list[tuple[str, str]] = []
        for rid, created, updated, blob in candidates:
            counts["candidates"] += 1
            try:
                data = json.loads(blob or "{}")
            except Exception:  # noqa: BLE001
                counts["skipped"] += 1
                continue
            # Empty means BOTH the count and the pointer list agree there is
            # nothing here — a row mid-projection must not be "repaired" to its
            # birth time while its messages are still landing.
            if int(data.get("message_count") or 0) != 0 or data.get("message_ids"):
                counts["skipped"] += 1
                continue
            counts["repaired"] += 1
            logger.info("conversation/%s: updated_date %s -> %s", rid[:8], updated, created)
            repairs.append((created, rid))
        # Written after the scan, never while iterating the read — one
        # executemany and one commit.
        if repairs and not dry_run:
            conn.executemany(
                "UPDATE entities SET updated_date = ? WHERE id = ? AND type = ?",
                [(created, rid, Conversation.get_type()) for created, rid in repairs],
            )
            conn.commit()
    finally:
        conn.close()
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)

    dry_run = not args.apply
    logger.info("Mode: %s", "DRY-RUN" if dry_run else "APPLY")
    try:
        counts = _repair(dry_run=dry_run)
    except Exception as e:  # noqa: BLE001
        logger.exception("Empty-conversation recency repair failed: %s", e)
        return 1
    logger.info(
        "conversations: candidates=%d repaired=%d skipped=%d",
        counts["candidates"], counts["repaired"], counts["skipped"],
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
