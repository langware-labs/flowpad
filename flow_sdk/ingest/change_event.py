"""The change envelope — one shape, any producer.

A webhook, a CLI, a scheduler or a test all announce a change the same way. The
system does not care who produced an event, only that its shape is right, so
this module owns the shape and nothing else owns a private path in.

**Identity and a locator, never content.** The payload names WHAT moved and
WHERE it lives; it never carries the bytes. That is the bus's standing rule
(*event ≠ proof*) and it is what keeps a replayed or duplicated event harmless:
the receiver re-derives from the source rather than trusting the message.

**`refs` is an optimization, never a guarantee.** A producer that knows exactly
which paths changed may say so; one that does not — Drive's `changes.watch`
carries no payload at all — sends none, and the receiver falls back to asking
the source. Correctness never depends on the hint, which is what makes a lost or
truncated event a latency problem rather than a data-loss one.

For git that fallback is unusually strong: the cursor holds a sha, so recovery is
``git diff <last-sha>..HEAD`` — exact and cheap, not a full enumerate.
"""
from __future__ import annotations

import logging
from typing import Any, Callable, Iterable, Optional

logger = logging.getLogger(__name__)

#: Tag layer + verb. The bus grammar is four fixed segments
#: (``ingest.<provider>.<layer>.<verb>``) so ``ingest.*.change.received``
#: subscribes to every provider's changes and nothing else.
CHANGE_LAYER = "change"
CHANGE_VERB = "received"


def change_tag(provider: str) -> str:
    return f"ingest.{provider}.{CHANGE_LAYER}.{CHANGE_VERB}"


def emit_change(
    source_id: str,
    provider: str,
    *,
    scope: str = "",
    refs: Iterable[str] = (),
    tombstones: Iterable[str] = (),
    origin: Optional[dict] = None,
    from_sha: str = "",
    to_sha: str = "",
    reason: str = "external",
) -> Any:
    """Announce that a source has changed. Safe to call from anywhere."""
    from flow_sdk.tags import emit_tag, target_of  # noqa: PLC0415

    return emit_tag(
        change_tag(provider),
        target_of("data_source", str(source_id)),
        {
            "source_id": str(source_id),
            "provider": provider,
            "scope": scope,
            "refs": list(refs),
            "tombstones": list(tombstones),
            "origin": origin or {},
            "from_sha": from_sha,
            "to_sha": to_sha,
            # Diagnostics only. Nothing may branch on it — the moment something
            # does, the producer stops being interchangeable and the whole point
            # of one envelope is gone.
            "reason": reason,
        },
    )


async def handle_change(event: Any) -> bool:
    """Reconcile the source an event names. Returns whether it ran.

    Deliberately ignores the event's `refs` today. The git driver's diff against
    its cursor sha is AUTHORITATIVE — it already reports exactly what moved,
    including renames — so trusting a hint instead could only ever be less
    accurate. The field stays in the envelope for sources whose transport gives
    a payload their driver cannot re-derive as cheaply.

    Never raises: an event handler that throws takes down nothing, because the
    bus deliberately does not await consumers and would only log the failure.
    """
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.ingest.sync import sync_source  # noqa: PLC0415

    data = getattr(event, "data", None) or {}
    source_id = str(data.get("source_id") or "")
    if not source_id:
        logger.debug("[ingest] change event with no source_id")
        return False
    try:
        source = await DataSource.get_by_id(source_id)
    except Exception:  # noqa: BLE001
        logger.warning("[ingest] could not load source %s", source_id, exc_info=True)
        return False
    if source is None:
        return False
    await sync_source(source)
    return True


def subscribe() -> Callable[[], None]:
    """Wire the bus to `handle_change`. Returns the unsubscriber.

    Kept a one-liner on purpose: the handler is what tests drive, so the
    subscription only has to be proven to CONNECT — the bus does not await
    async consumers, and a test that emitted and asserted would be racing a
    detached task.
    """
    from flow_sdk.tags import on_tag  # noqa: PLC0415

    return on_tag(f"ingest.*.{CHANGE_LAYER}.{CHANGE_VERB}", handle_change)
