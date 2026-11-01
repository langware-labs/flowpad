"""One-shot repair: the hidden diagnosis support messages are no longer "owed" to the hub.

``report.py`` used to write each diagnosis's hidden support conversation ("Flowpad diagnostics —
<date>", no members) with an ``outbound`` summary message, "to be sent when Report issue shares the
conversation". Report never shared it -- it emails the team -- so every such message stayed owed:
the outbox counted it on every flush ("delivered 0 of 25 owing conversation(s)") and skipped it,
forever. ``report.py`` no longer marks it outbound; this clears the ones already written.

Only messages in a member-less, non-remote conversation titled ``Flowpad diagnostics —`` are touched;
the message itself stays. Idempotent.

Usage (dry-run is the default; ``--apply`` writes):
    uv run -m flow_sdk.migrations.migration_2026_10_diagnosis_support_not_owed
    uv run -m flow_sdk.migrations.migration_2026_10_diagnosis_support_not_owed --apply
"""

from __future__ import annotations

import argparse
import asyncio
import json
import sys

SUPPORT_TITLE = "Flowpad diagnostics —"


def is_support_conversation(conv) -> bool:
    return (
        (getattr(conv, "title", "") or "").startswith(SUPPORT_TITLE)
        and not getattr(conv, "members", None)
        and not getattr(conv, "remote", False)
    )


async def repair(*, dry_run: bool = True) -> dict[str, int]:
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415
    from flow_sdk.builtin.flow_message import FlowMessage  # noqa: PLC0415
    from flow_sdk.db.drivers.query import QueryFilter  # noqa: PLC0415

    counts = {"conversations": 0, "messages": 0, "cleared": 0}
    owed = await FlowMessage.get_all(QueryFilter(match={"outbound": True}), hydrate=False)
    by_conv: dict[str, list] = {}
    for fm in owed or []:
        if fm.conversation_id and fm.owes_delivery:
            by_conv.setdefault(fm.conversation_id, []).append(fm)
    for conv_id, messages in by_conv.items():
        conv = await Conversation.get_one({"id": conv_id})
        if conv is None or not is_support_conversation(conv):
            continue
        counts["conversations"] += 1
        for fm in messages:
            counts["messages"] += 1
            if dry_run:
                continue
            full = await FlowMessage.get_one({"id": fm.id})
            if full is None:
                continue
            full.outbound = False
            await full.save()
            counts["cleared"] += 1
    return counts


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--apply", action="store_true", help="write (default: dry-run)")
    args = parser.parse_args(argv)
    from flow_sdk.db.database import init_db  # noqa: PLC0415

    async def _go() -> dict[str, int]:
        await init_db()
        return await repair(dry_run=not args.apply)

    sys.stdout.write(json.dumps({"dry_run": not args.apply, **asyncio.run(_go())}) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
