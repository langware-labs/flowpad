"""Boot lift: give every Conversation its ``attachment_count``.

``attachment_count`` (the inbox row's paperclip) is projected with ``message_count`` by
``project_pointers_to_entity``, so a conversation counts its files the next time a message
lands. A quiet conversation may never be projected again, so this pass fills the rows that
predate the field — those whose stored data has no ``attachment_count`` key at all.

Each one is counted exactly as the projection counts it (``Conversation.messages_by_edge`` +
``count_listed_files``) and written through the projection's own writer. Cheap on every later
boot: the candidate query matches no row once each one carries the key.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_11_attachment_count --apply
"""

from __future__ import annotations

import argparse
import logging
import sys

from flow_sdk.builtin.conversation import _PROJECTION_SENTINEL, Conversation

logger = logging.getLogger(__name__)


def _missing_ids(db_path: str) -> list[str]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415

    conn = open_sqlite(db_path, mode="ro")
    try:
        return [
            rid
            for (rid,) in conn.execute(
                "SELECT id FROM entities WHERE type = ? AND json_type(data, '$.attachment_count') IS NULL",
                (Conversation.get_type(),),
            )
        ]
    finally:
        conn.close()


async def lift(*, dry_run: bool = True, db_path: str | None = None) -> dict[str, int]:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    filled = with_files = 0
    for rid in _missing_ids(db_path or str(get_instance_settings().db_path)):
        conv = await Conversation.get_one({"id": rid})
        if conv is None:
            continue
        count = Conversation.count_listed_files(await conv.messages_by_edge())
        filled += 1
        with_files += bool(count)
        if not dry_run:
            conv._set_projection("attachment_count", count, _PROJECTION_SENTINEL)
            await conv.save(None, notify=False)
    return {"filled": filled, "with_files": with_files}


def main(argv: list[str] | None = None) -> int:
    import asyncio  # noqa: PLC0415

    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--apply", action="store_true", help="Apply changes (default: dry-run).")
    args = parser.parse_args(argv)
    logging.basicConfig(level=logging.INFO, format="%(message)s", force=True)
    logger.info("attachment_count: %s", asyncio.run(lift(dry_run=not args.apply)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
