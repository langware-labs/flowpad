"""AgentMail — a mailbox the agent owns, over a REST API.

The second transport for the same channel shape, and the reason it exists is
not variety: **it can send.** The harness's Gmail connector cannot — it exposes
`create_draft` / `update_draft` / `list_drafts` and no send verb at all — so a
reply composed through it stops as a draft the user must finish by hand. This
driver closes that loop.

It is also the proof that the driver seam holds. `fetch` and `send` here are
plain HTTP; everything above them — the digest gate, deterministic identity,
the inbox projection, threading, the conversation UI — is untouched and shared
with the agent transport. Adding a channel really is one file.

Config on the DataSource::

    {"inbox": "someone@agentmail.to",
     "api_key": "am_...",                 # provider-opaque, like every driver's
     "base_url": "https://api.agentmail.to/v0"}
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flow_sdk.ingest.driver import (
    FetchResult,
    SendOutcome,
    SendStatus,
    SegmentCursorView,
    SegmentRef,
)
from flow_sdk.ingest.health import SourceError
from flow_sdk.ingest.models import IngestItem

logger = logging.getLogger(__name__)

DEFAULT_BASE_URL = "https://api.agentmail.to/v0"

#: One page per fetch. The cursor's high-water mark does the rest, and a
#: mailbox that needs more than this in one cycle gets it on the next.
PAGE_LIMIT = 25

#: Network budget. Not a retry knob — a hung request must fail the cycle so the
#: cursor stays put, rather than stall the poller's slot.
REQUEST_TIMEOUT_SECONDS = 30


class AgentMailDriver:
    provider = "agentmail"
    kind = "datasource.api.agentmail"
    record_kind = "content.message.email"
    #: Unlike the harness transport, this one really sends.
    sends = True

    def channel_for(self, source) -> str:
        return "agentmail"

    def segments(self, source) -> list[SegmentRef]:
        inbox = self._inbox(source)
        return [SegmentRef(inbox, inbox)]

    # ── fetch ────────────────────────────────────────────────────────────────

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        payload = await self._get(
            source,
            f"/inboxes/{self._inbox(source)}/messages",
            params={"limit": PAGE_LIMIT},
        )
        messages = payload.get("messages") or []

        floor = str((cursor.state or {}).get("high_water") or "")
        items: list[IngestItem] = []
        high_water = floor
        for msg in messages:
            stamp = str(msg.get("timestamp") or "")
            # Skip what we have already seen. The digest gate would make a
            # re-ingest harmless, but not fetching beats de-duplicating.
            if floor and stamp and stamp <= floor:
                continue
            items.append(self._to_item(source, msg))
            if stamp > high_water:
                high_water = stamp

        state = dict(cursor.state or {})
        if high_water:
            state["high_water"] = high_water
        return FetchResult(items=items, next_state=state, high_water=high_water or None, unchanged=not items)

    def _to_item(self, source, msg: dict) -> IngestItem:
        """One AgentMail message → the shared envelope.

        `message_id` is the RFC 5322 id and is what the provider itself uses as
        a key, so it is the right `external_id`: identity stays stable across
        re-fetches and across this driver and any other that sees the same mail.
        """
        sender = str(msg.get("from") or "")
        return IngestItem(
            source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=self._inbox(source),
            external_id=str(msg.get("message_id") or ""),
            title=str(msg.get("subject") or ""),
            body=str(msg.get("preview") or ""),
            occurred_at=str(msg.get("timestamp") or "") or None,
            author_display=sender,
            author_external_id=_address_of(sender),
            thread_key=str(msg.get("thread_id") or "") or None,
        )

    # ── send ─────────────────────────────────────────────────────────────────

    async def send(
        self,
        source,
        *,
        thread_key: str,
        to: str,
        text: str,
        subject: str = "",
        conversation_id: str = "",
        in_reply_to: str = "",
    ) -> SendOutcome:
        """Deliver, for real.

        Two routes, and the difference matters to the recipient: replying to a
        known message keeps the exchange one thread on their side, while a bare
        send starts a new one. `reply` takes the RFC 5322 message id in the
        PATH, so it must be URL-encoded — the id contains `<`, `>` and `@`, and
        passing it raw is a 400 that reads like a bad body.

        The sent copy is NOT recorded here. AgentMail labels it `sent` and
        returns it from the same list endpoint `fetch` reads, so the ordinary
        ingest path records it once under the same deterministic id. Writing it
        here as well would be the same row twice.
        """
        from urllib.parse import quote  # noqa: PLC0415

        inbox = self._inbox(source)
        if in_reply_to:
            path = f"/inboxes/{inbox}/messages/{quote(in_reply_to, safe='')}/reply"
            body: dict[str, Any] = {"text": text}
        else:
            path = f"/inboxes/{inbox}/messages/send"
            body = {"to": [to], "text": text}
            if subject:
                body["subject"] = subject

        payload = await self._post(source, path, body)
        return SendOutcome(
            external_id=str(payload.get("message_id") or ""),
            status=SendStatus.SENT,
            # The mailbox is the record; the next poll ingests it.
            recorded=False,
        )

    # ── HTTP ─────────────────────────────────────────────────────────────────

    @staticmethod
    def _inbox(source) -> str:
        inbox = str((source.config or {}).get("inbox") or "").strip()
        if not inbox:
            raise SourceError.config("no_inbox", "config.inbox is required")
        return inbox

    @staticmethod
    def _auth(source) -> dict[str, str]:
        key = str((source.config or {}).get("api_key") or "").strip()
        if not key:
            raise SourceError.config("no_api_key", "config.api_key is required")
        return {"Authorization": f"Bearer {key}"}

    @staticmethod
    def _base(source) -> str:
        return str((source.config or {}).get("base_url") or DEFAULT_BASE_URL).rstrip("/")

    async def _get(self, source, path: str, params: Optional[dict] = None) -> dict:
        return await self._request(source, "GET", path, params=params)

    async def _post(self, source, path: str, json_body: dict) -> dict:
        return await self._request(source, "POST", path, json_body=json_body)

    async def _request(
        self, source, method: str, path: str, *, params: Optional[dict] = None, json_body: Optional[dict] = None
    ) -> dict:
        import httpx  # noqa: PLC0415

        url = f"{self._base(source)}{path}"
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.request(
                    method,
                    url,
                    headers=self._auth(source),
                    params=params,
                    json=json_body,
                )
        except httpx.HTTPError as exc:
            # The network, not the config — the next cycle may well succeed.
            raise SourceError.transient("network", f"{method} {path}: {exc}") from exc

        if response.status_code in (401, 403):
            # A bad key needs a human; retrying forever would just park the
            # source in a loop nobody sees.
            raise SourceError.config("auth_failed", f"{method} {path}: {response.status_code}")
        if response.status_code >= 400:
            raise SourceError.transient("http_error", f"{method} {path}: {response.status_code} {response.text[:200]}")
        try:
            return response.json() or {}
        except ValueError as exc:
            raise SourceError.transient("bad_json", f"{method} {path}: {exc}") from exc


def _address_of(sender: str) -> str:
    """`Joe <joe@x.to>` → `joe@x.to`. Same stdlib reader the projector uses."""
    from email.utils import parseaddr  # noqa: PLC0415

    return parseaddr(sender or "")[1] or (sender or "").strip()
