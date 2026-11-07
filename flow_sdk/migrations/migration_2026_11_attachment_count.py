"""Boot lift: give every Conversation its ``attachment_count``.

``attachment_count`` (the inbox row's paperclip) is projected with ``message_count`` by
``project_pointers_to_entity``, so a conversation counts its files the next time a message
lands. A quiet conversation may never be projected again, so this pass fills the rows that
predate the field — those whose stored data has no ``attachment_count`` key at all.

One SQL read counts the listed files (``Attachment.is_listed_file``: a FILE, or a ``prompt/``
file) per ``conversation_id``; one ``executemany`` writes them. Idempotent and cheap on every
later boot: the candidate query matches no row once each one carries the key.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_11_attachment_count --apply
"""

from __future__ import annotations

import argparse
import logging
import sys

from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.flow_message import FlowMessage

logger = logging.getLogger(__name__)

_COUNTS_SQL = """
SELECT json_extract(m.data, '$.conversation_id') AS cid, count(*)
FROM entities m, json_each(json_extract(m.data, '$.attachment')) a
WHERE m.type = ?
  AND (json_extract(a.value, '$.attachment_type') = 'file'
       OR (json_extract(a.value, '$.attachment_type') = 'prompt'
           AND json_extract(a.value, '$.data') LIKE 'prompt/%'))
GROUP BY cid
"""


async def lift(*, dry_run: bool = True) -> dict[str, int]:
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    conn = open_sqlite(get_instance_settings().db_path)
    try:
        missing = [
            rid
            for (rid,) in conn.execute(
                "SELECT id FROM entities WHERE type = ? AND json_type(data, '$.attachment_count') IS NULL",
                (Conversation.get_type(),),
            )
        ]
        if not missing:
            return {"filled": 0}
        counts = dict(conn.execute(_COUNTS_SQL, (FlowMessage.get_type(),)).fetchall())
        rows = [(int(counts.get(rid, 0)), rid, Conversation.get_type()) for rid in missing]
        if not dry_run:
            conn.executemany(
                "UPDATE entities SET data = json_set(data, '$.attachment_count', ?) WHERE id = ? AND type = ?", rows
            )
            conn.commit()
        return {"filled": len(rows), "with_files": sum(1 for n, *_ in rows if n)}
    finally:
        conn.close()


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
