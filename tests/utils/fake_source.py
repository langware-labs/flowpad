"""``ScriptedDriver`` — a message-shaped ingest driver that answers what a test tells it to.

Registered under any provider name, so a snippet written for ``agentmail`` or ``slack`` runs
verbatim with no network: ``fetch`` hands out the next scripted page, ``send`` records what
was sent and returns ``recorded=False`` like the real senders do, so the redelivery paths get
exercised the way they are in production.
"""

from __future__ import annotations

import asyncio
from collections import deque
from contextlib import contextmanager
from typing import Iterable, Optional

import flow_sdk.ingest.drivers  # noqa: F401 — the shipped drivers register FIRST, so an override below is not undone by a later import
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import (
    DRIVERS,
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SetupVerdict,
)

SEGMENT = "s"


class ScriptedDriver(IngestDriver):
    provider = "scripted"
    kind = "datasource.api.scripted"
    sends = True
    identity_config_key = "inbox"
    connection = None
    attention_poll_seconds = None

    def __init__(self, provider: str = "scripted", *, pages: Iterable[list[dict]] = ()):
        self.provider = provider
        self.kind = f"datasource.api.{provider}"
        self.pages: deque[list[dict]] = deque(pages)
        self.sent: list[dict] = []
        #: Set on every send. NOT a safe place to stop a fence: a send happens INSIDE
        #: ``reply()``, before the ack, so cancelling here reproduces the crash window.
        self.sent_event = asyncio.Event()
        #: Set by the first ``fetch`` after a send — the loop has replied, acked, slept and
        #: come round again. The "done" signal for ``run_fence_until``.
        self.settled = asyncio.Event()
        self._sent_at_last_fetch = 0
        self.fetches = 0

    # ── the test's controls ──────────────────────────────────────────────

    def push(self, *messages: dict) -> None:
        """Queue one page of inbound messages for the next fetch."""
        self.pages.append(list(messages))

    # ── the contract ─────────────────────────────────────────────────────

    async def verify(self, source) -> SetupVerdict:
        return SetupVerdict.ok()

    async def segments(self, source) -> list[SegmentRef]:
        return [SegmentRef(key=SEGMENT, label="scripted")]

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        self.fetches += 1
        if len(self.sent) > self._sent_at_last_fetch:
            self._sent_at_last_fetch = len(self.sent)
            self.settled.set()
        if not self.pages:
            return FetchResult(unchanged=True, next_state=dict(cursor.state or {}))
        page = self.pages.popleft()
        items = [self._spec(source, m) for m in page]
        return FetchResult(items=items, next_state={"n": self.fetches})

    async def send(self, source, *, thread_key, to, text, subject="", conversation_id="", in_reply_to="") -> SendOutcome:
        external_id = f"<sent-{mint_uuid()}@{self.provider}>"
        self.sent.append({
            "external_id": external_id, "thread_key": thread_key, "to": to,
            "text": text, "subject": subject, "in_reply_to": in_reply_to,
        })
        self.sent_event.set()
        return SendOutcome(external_id=external_id, recorded=False)

    def _spec(self, source, m: dict) -> SourceItemSpec:
        # Globally unique, as a provider's ids are. A per-instance counter collided across
        # tests sharing one source: the same natural key resolves to the SAME row, so the
        # "new" message became an update of an old one and was never yielded.
        return SourceItemSpec(
            data_source_id=str(source.id),
            provider=self.provider,
            kind="message",
            segment_key=SEGMENT,
            external_id=m.get("external_id") or f"<{mint_uuid()}@{self.provider}>",
            name=m.get("name", ""),
            body=m.get("body", ""),
            author_external_id=m.get("author", "someone@example.com"),
            thread_key=m.get("thread_key", "thr-1"),
            reply_to_external_id=m.get("reply_to_external_id"),
            occurred_at=m.get("occurred_at"),
        )


@contextmanager
def scripted_provider(provider: str = "scripted", *, pages: Iterable[list[dict]] = ()):
    """Register a ``ScriptedDriver`` under *provider* for the block, restoring what was there."""
    previous: Optional[IngestDriver] = DRIVERS.get_or_none(provider)
    driver = ScriptedDriver(provider, pages=pages)
    DRIVERS.register(driver)
    try:
        yield driver
    finally:
        DRIVERS.unregister(provider)
        if previous is not None:
            DRIVERS.register(previous)


__all__ = ["ScriptedDriver", "scripted_provider", "SEGMENT"]
