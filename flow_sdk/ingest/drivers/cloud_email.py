"""Cloud email — a mailbox the hub allocates and holds the credential for.

The third transport for the same channel shape, and what makes it different is
not the protocol: **there is nothing to paste.** `agentmail` needs an inbox
address and an API key typed into the source and stored on disk; here the hub
owns the provider credential, allocates the address, and this driver reaches it
through the email-inbox driver family (`flow_sdk/builtin/email_inbox_driver.py`)
with the user's ordinary cloud login. The DataSource carries no secret at all.

Which backend serves the mailbox is not this module's business — that is the
family's. What lives here is the ingest half: mapping a message onto the shared
envelope, and deciding which failures park a source.

Config on the DataSource::

    {"agent_id": "<uuid>",          # the ONLY load-bearing key
     "address": "someone@…",        # display + byline; allocated, may change
     "inbox_typeid": "…",           # diagnostic
     "provider_inbox_id": "…"}      # diagnostic

The hub addresses a mailbox by AGENT, never by address — one inbox per agent is
its model (`flowpad/hub/builtin/email_inbox.py`). So `agent_id` is the stream
key: it is immutable, it is the thing without which nothing can poll, and
`segment_key` is one third of a SourceItem's natural key, so keying on the
allocated address would orphan every row the day an inbox is re-provisioned.
"""

from __future__ import annotations

import logging
from typing import Any, Optional

from flow_sdk.builtin.email_inbox_driver import EmailInboxError
from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SendStatus,
)
from flow_sdk.ingest.health import SourceError

logger = logging.getLogger(__name__)

#: One page per fetch. The cursor does the rest, and a mailbox needing more than
#: this in one cycle gets it on the next — `agentmail`'s precedent.
PAGE_LIMIT = 25

#: How far back the `after` parameter is nudged before it is sent.
#:
#: The hub's filter is EXCLUSIVE (`timestamp <= after` is rejected), so asking
#: for `after=<high water>` does not re-deliver a message that shares the
#: boundary second — it drops it, permanently. Providers stamp to the second and
#: mail arrives in bursts, so that is a real loss. We over-fetch by a second and
#: filter locally instead: the digest gate makes an accidental re-read free, but
#: nothing makes a dropped message come back.
BOUNDARY_NUDGE_SECONDS = 1


class CloudEmailDriver(IngestDriver):
    provider = "cloud_email"
    kind = "datasource.cloud.email"
    record_kind = "content.message.email"
    #: One source per Hub Agent mailbox. The address is mutable attribution
    #: data; the Agent id is the Hub API's stable mailbox key.
    identity_config_key = "agent_id"
    #: The hub sends and replies for us — see `send`.
    sends = True
    #: Mailbox-grade while watched. This reuses the poller's attention lease;
    #: the configured background cadence remains untouched.
    attention_poll_seconds = 5

    def channel_for(self, source) -> str:
        """The medium, not the transport.

        The channel is half the deterministic thread id
        (`uuid5(f"message_thread:{channel}:{thread_key}")` in the inbox
        projection), so it has to name what the mail IS. Returning
        `"cloud_email"` would badge how it arrived, and the day a second
        transport reads the same mailbox every thread would fork in two.
        """
        return "email"

    async def segments(self, source) -> list[SegmentRef]:
        return [SegmentRef(key=self._agent_id(source), label=self._address(source))]

    # ── fetch ────────────────────────────────────────────────────────────────

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        state = dict(cursor.state or {})
        floor = str(state.get("high_water") or cursor.window_start or "")
        seen_at_floor = set(state.get("boundary_ids") or [])

        params: dict[str, str] = {"limit": str(PAGE_LIMIT), "ascending": "true"}
        if floor:
            params["after"] = _nudge_back(floor)
        # Deliberately NO `labels` filter. `send` returns `recorded=False` on the
        # promise that the next poll ingests the sent copy through this very
        # path — filtering to `received` would make every reply the user sends
        # vanish from its own thread. The projection attributes our own mail via
        # the source's `account_identities`.

        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        mailbox = get_email_inbox_driver()
        agent = self._agent_id(source)

        payload = await self._mailbox(mailbox.list_messages(agent, **params))
        messages = payload.get("messages") or []

        items: list[SourceItemSpec] = []
        high_water = floor
        boundary_ids: list[str] = list(seen_at_floor) if floor else []

        for msg in messages:
            stamp = str(msg.get("timestamp") or "")
            message_id = str(msg.get("message_id") or "")
            if not message_id:
                continue
            if floor and stamp:
                if stamp < floor:
                    continue
                if stamp == floor and message_id in seen_at_floor:
                    continue

            # Hydrate BEFORE mapping: the list call carries `preview`, and only
            # `messages/<id>` carries `text`. `body` is a digested field, so
            # ingesting a preview now and the real text later would rewrite the
            # row and re-fire every trigger on mail that never changed.
            try:
                full = await self._mailbox(mailbox.get_message(agent, message_id))
            except SourceError:
                # Stop here rather than skipping past it: advancing the cursor
                # over a message we failed to read would lose it for good. The
                # prefix we did hydrate is returned; the next tick retries this
                # one. Not a retry ladder — the cadence IS the retry.
                logger.warning("[cloud_email] hydration failed at %s; keeping the cursor here", message_id)
                break

            items.append(self._to_item(source, full or msg))
            if stamp > high_water:
                high_water, boundary_ids = stamp, [message_id]
            elif stamp == high_water:
                boundary_ids.append(message_id)

        if high_water:
            state["high_water"] = high_water
            state["boundary_ids"] = boundary_ids
        return FetchResult(
            items=items,
            next_state=state,
            high_water=high_water or None,
            unchanged=not items,
        )

    def _to_item(self, source, msg: dict) -> SourceItemSpec:
        """One hub `EmailMessage` → the shared envelope.

        `sender` arrives already structured (`{address, name}`) because the hub
        normalizes it — no header parsing here, unlike the AgentMail driver
        which has to read a `"Name <addr>"` string.
        """
        sender = msg.get("sender") or {}
        address = str(sender.get("address") or "")
        return SourceItemSpec(
            data_source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=self._agent_id(source),
            segment_label=self._address(source),
            external_id=str(msg.get("message_id") or ""),
            name=str(msg.get("subject") or ""),
            body=_body_of(msg),
            occurred_at=str(msg.get("timestamp") or "") or None,
            author_external_id=address,
            author_display=str(sender.get("name") or "") or address,
            thread_key=self._thread_key(source, msg),
            reply_to_external_id=str(msg.get("in_reply_to") or "") or None,
            raw=msg,
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
        """Push one message into the mailbox and let the poller record it.

        MUST NOT raise `SourceError` — that health parks the DataSource, and one
        failed reply must never stop a mailbox syncing (the driver Protocol says
        so). An `EmailInboxError` propagates to the outbound logger instead.
        """
        body: dict[str, Any] = {"to": to, "text": text}
        if subject:
            body["subject"] = subject

        from flow_sdk.builtin.email_inbox_driver import get_email_inbox_driver  # noqa: PLC0415

        driver = get_email_inbox_driver()
        agent_id = self._agent_id(source)
        if in_reply_to:
            data = await driver.reply(agent_id, in_reply_to, body)
        else:
            data = await driver.send(agent_id, body)
        # `recorded=False`: the hub files the sent copy under the same mailbox
        # and the next poll ingests it through the ordinary path, so recording
        # it here would write the row twice.
        return SendOutcome(
            external_id=str((data or {}).get("message_id") or ""),
            status=SendStatus.SENT,
            recorded=False,
        )

    # ── the hub, and what its failures mean ──────────────────────────────────

    @staticmethod
    async def _mailbox(coro) -> dict:
        """Await one mailbox call, translating its failure into a health.

        Which backend, which credential, which URL is the email-inbox driver's
        business. What belongs here is the other half: whether a failure parks
        this source or is retried on the next tick. That is ingest policy, so it
        stays in ingest.
        """
        try:
            return await coro or {}
        except EmailInboxError as exc:
            raise _as_source_error(exc) from exc

    @classmethod
    def _thread_key(cls, source, msg: dict) -> Optional[str]:
        """The provider thread id, SCOPED TO THIS MAILBOX.

        AgentMail's ``thread_id`` is inbox-scoped, not global — the hub's own
        docs say so and warn "never use it as a cross-agent key". The inbox
        projection derives a MessageThread id from ``(channel, thread_key)``
        alone, and every cloud mailbox reports the same channel (``email``), so
        a bare provider id lets two agents whose mailboxes happen to agree on a
        thread id collapse onto ONE thread — and therefore one conversation, and
        therefore one agent process. Prefixing the agent makes the key mean what
        the projection assumes it means.

        Returns None when the provider gave us nothing, so
        ``projection.thread_key_for`` can fall back to the normalized subject
        rather than threading every stranger onto the string ``"<agent>:"``.
        """
        thread_id = str(msg.get("thread_id") or "").strip()
        return f"{cls._agent_id(source)}:{thread_id}" if thread_id else None

    @staticmethod
    def _agent_id(source) -> str:
        """The mailbox's agent, required. Reads through `inbox.projection`'s
        `agent_id_of` — that key is load-bearing for thread scoping, sender
        attribution and the runner's gate, and a second spelling of the lookup
        would fix one lane and not the others."""
        from flow_sdk.inbox.projection import agent_id_of  # noqa: PLC0415

        agent_id = agent_id_of(source)
        if not agent_id:
            raise SourceError.config("no_agent", "config.agent_id is required")
        return agent_id

    @staticmethod
    def _address(source) -> str:
        return str((getattr(source, "config", None) or {}).get("address") or "").strip()


def _as_source_error(exc: EmailInboxError) -> SourceError:
    """Mailbox failure → the health that decides whether we keep polling.

    Takes the FAMILY's error, not the hub's, so this keeps working when a second
    backend joins. Everything with a real HTTP status goes through
    `SourceError.for_status` — THE status→health table — rather than growing a
    second copy of it here. Only the two cases that table cannot know about are
    named:

    * **no status at all.** `status_code == 0` is either "backend not configured
      / signed out", which needs a person, or a transport failure, which needs
      the next tick.
    * **404.** On this route it means the agent has no inbox — re-provisioning is
      a human act, so it parks rather than retrying forever.
    """
    if exc.status_code == 0:
        if "not configured" in (exc.reason or ""):
            return SourceError.config("mailbox_not_configured", exc.reason)
        return SourceError.transient("network", exc.reason)
    if exc.status_code == 404:
        return SourceError.config("no_inbox", exc.reason or "this agent has no mailbox")
    return SourceError.for_status(exc.status_code, exc.reason or "")


def _body_of(msg: dict) -> str:
    """The message body, by ONE deterministic rule.

    `text` when the provider gave one, else the html, else empty — and never the
    `preview`. The rule has to be a function of the message rather than of which
    fields a given call happened to populate: `body` is digested, so a body that
    depends on the caller flips the digest on the next poll and rewrites a record
    that never changed.
    """
    text = str(msg.get("text") or "").strip()
    if text:
        return text
    return str(msg.get("html") or "").strip()


def _nudge_back(iso: str) -> str:
    """`iso` minus one second, so an exclusive `after` cannot eat the boundary.

    Falls back to the input unchanged when it is not parseable — over-fetching
    is the safe direction, and a filter we cannot compute is better sent as-is
    than dropped entirely.
    """
    from datetime import timedelta  # noqa: PLC0415

    from flow_sdk.utils.serialization import iso_to_utc  # noqa: PLC0415

    parsed = iso_to_utc(iso)
    if parsed is None:
        return iso
    return (parsed - timedelta(seconds=BOUNDARY_NUDGE_SECONDS)).isoformat()
