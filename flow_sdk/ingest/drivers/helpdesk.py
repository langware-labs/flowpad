"""Help desk — a hub desk's tickets as a MessageSource.

A ticket is a hub conversation (``kind=helpdesk``): a guest opens it against a
desk project, staff *pick it up* to join, and every reply is an ordinary hub
message the hub masks to the desk's brand. Until now that was the one inbound
channel that bypassed the source machinery — a separate pool view, its own row
markup, a Pick-up button. This driver makes the desk a source like Slack or
Gmail: the pool is the segment list, a ticket's messages are the records, and a
reply is ``send``.

Config on the DataSource::

    {"desk_project_id": "<hub project id>"}   # the ONLY load-bearing key

**Both writers, one row.** A ticket's messages also reach this machine through
the hub mirror once the owner is a participant. So every record carries the
hub ids as adoption hints (``conversation_id`` / ``message_id`` on the
envelope): the projection adopts the mirrored Conversation instead of minting
one and mints the FlowMessage with the hub's own id — see ``SourceItemSpec``.

Auth is the ordinary cloud login; the DataSource carries no secret. Which
failures park the source is decided here: signed out and not-a-member are a
person's to fix, a dropped connection waits for the next tick.
"""

from __future__ import annotations

import logging
from typing import Any

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.cloud_client.shared.errors import HubError
from flow_sdk.cloud_client.transport.hub_http import rows_of
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SendStatus,
    identity_stamped,
    stamp_identity,
)
from flow_sdk.ingest.drivers._watermark import Watermark
from flow_sdk.ingest.health import SourceError
from flow_sdk.schema.data_spec.choice_spec import Choice
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)

#: The hub channel name. Half the thread key, so it names what a ticket IS.
CHANNEL = "helpdesk"


class HelpdeskDriver(IngestDriver):
    provider = "helpdesk"
    kind = "datasource.hub.helpdesk"
    record_kind = "content.message.chat"
    identity_config_key = "desk_project_id"
    #: A reply is pickup + add_message on the hub — see `send`.
    sends = True
    #: Strangers are the point: an empty allowlist admits every requester.
    open_inbound = True
    #: Chat-grade while watched, like telegram.
    attention_poll_seconds = 5

    def __init__(self) -> None:
        #: Per source, the pool's `(message_count, updated_at)` per ticket as
        #: of the last `segments` call — `fetch` skips a ticket whose pair has
        #: not moved, so a watched desk costs one GET per tick, not one per
        #: ticket. Memory only: the pool is re-read every pass anyway.
        self._pool_stamps: dict[str, dict[str, str]] = {}

    def channel_for(self, source) -> str:
        return CHANNEL

    @classmethod
    def outbound_spec(cls, source):
        from flow_sdk.builtin.source_item import HelpdeskMessageSpec  # noqa: PLC0415

        return HelpdeskMessageSpec

    # ── streams: the pool ────────────────────────────────────────────────────

    async def segments(self, source) -> list[SegmentRef]:
        """One stream per ticket in the desk's pool — picked up or not: the
        pool route lists every ``kind=helpdesk`` child for a member."""
        desk = self._desk(source)
        rows = await self._hub_get(EntityType.PROJECT, desk, "helpdesk_conversations")
        refs: list[SegmentRef] = []
        stamps: dict[str, str] = {}
        for row in rows_of(rows):
            conv_id = str(row.get("conversation_id") or "").strip()
            if not conv_id:
                continue
            label = str(row.get("title") or row.get("preview") or "").strip()[:80] or conv_id
            refs.append(SegmentRef(key=conv_id, label=label))
            stamps[conv_id] = f"{row.get('message_count') or 0}:{row.get('updated_at') or ''}"
        self._pool_stamps[str(source.id)] = stamps
        return refs

    # ── fetch: one ticket's messages ─────────────────────────────────────────

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        """The ticket's messages since the watermark.

        The hub's children route has no ``since``: it returns every message
        with its ``updated_date``. The cursor keeps a high-water mark on that
        stamp plus the ids seen AT the mark (a burst can share a second), and
        an edited message re-arrives because its stamp moved — the digest gate
        decides whether that is a change.
        """
        await self._ensure_identity(source)
        state = dict(cursor.state or {})
        conv_id = cursor.segment_key

        # The pool row already says whether the ticket moved; a ticket that
        # did not is one GET saved.
        pool_stamp = self._pool_stamps.get(str(source.id), {}).get(conv_id, "")
        if pool_stamp and pool_stamp == state.get("pool_stamp"):
            return FetchResult(items=[], next_state=state, high_water=state.get("high_water"), unchanged=True)

        mark = Watermark.from_state(state)
        children = await self._hub_get(EntityType.CONVERSATION, conv_id, "flow_message")
        items: list[SourceItemSpec] = []
        for fm in sorted(rows_of(children), key=_stamp_of):
            fm_id = str(fm.get("id") or "").strip()
            stamp = _stamp_of(fm)
            if not fm_id or not mark.is_new(stamp, fm_id):
                continue
            items.append(self._to_item(source, conv_id, fm_id, fm))
            mark.advance(stamp, fm_id)

        if pool_stamp:
            state["pool_stamp"] = pool_stamp
        return FetchResult(items=items, next_state=mark.into(state), high_water=mark.high_water or None, unchanged=not items)

    def _to_item(self, source, conv_id: str, fm_id: str, fm: dict) -> SourceItemSpec:
        """One hub FlowMessage → the shared envelope, with the adoption hints.
        The ticket's hub id is the thread key: a uuid, unique across desks, so
        `(channel, thread_key, owner)` needs no desk prefix."""
        sender_id = str(fm.get("sender_id") or "").strip()
        return SourceItemSpec(
            data_source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=conv_id,
            segment_label=conv_id,
            external_id=fm_id,
            name="",
            body=str(fm.get("text") or ""),
            occurred_at=str(fm.get("created_date") or "") or None,
            author_external_id=sender_id or None,
            author_display=str(fm.get("sender_name") or "") or (sender_id or None),
            thread_key=conv_id,
            conversation_id=conv_id,
            message_id=fm_id,
            raw=fm,
        )

    # ── send: pick up, then answer ───────────────────────────────────────────

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
        """Answer a ticket: pick it up, then post. The hub fans a ticket's
        messages out to participants only, so pickup is what makes the answer
        (and the guest's next word) reach this machine. Pickup is idempotent
        on the hub — a participant picking up again is a no-op — so it is
        simply always sent rather than paid for with a read first.

        MUST NOT raise `SourceError` — that health parks the DataSource, and
        one failed reply must never stop the desk polling. A `HubError`
        propagates to the outbound logger instead.
        """
        from flow_sdk.cloud_client.transport.hub_http import hub_post  # noqa: PLC0415

        ticket = (to or conversation_id or "").strip()
        if not ticket:
            raise ValueError("a help-desk reply needs the ticket's conversation id")

        await hub_post(EntityType.CONVERSATION, {}, ticket, "pickup")
        data = await hub_post(EntityType.CONVERSATION, {"text": text, "conversation_id": ticket}, ticket, "add_message")
        # `recorded=False`: the hub files the reply into the ticket and the next
        # poll ingests it through the ordinary path, onto the hub's own id.
        return SendOutcome(external_id=str((data or {}).get("id") or ""), status=SendStatus.SENT, recorded=False)

    # ── the picker: which desks can I attach? ────────────────────────────────

    async def choices(self, source, field: str) -> list[Choice]:
        """The desks this login can reach: the deployment's default desk and
        every desk adopted into a local project. Typing an id still works."""
        if field != "desk_project_id":
            return []
        from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
        from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415

        out: list[Choice] = []
        default = await resolve_helpdesk()
        if default is not None:
            out.append(Choice(id=default.project_id, name="Flowpad Support", detail="the deployment's default desk"))
        try:
            desks = await Helpdesk.get_all({})
        except Exception:  # noqa: BLE001 — no adopted desks is not a failure
            desks = []
        for desk in desks or []:
            queue = str(getattr(desk, "desk_project_id", "") or "").strip()
            if queue and all(c.id != queue for c in out):
                out.append(Choice(id=queue, name=str(getattr(desk, "display_name", "") or queue), detail="adopted desk"))
        return out

    # ── the hub, and what its failures mean ──────────────────────────────────

    @staticmethod
    async def _hub_get(entity_type, entity_id: str, action: str) -> Any:
        from flow_sdk.cloud_client.transport.hub_http import hub_get_or_raise  # noqa: PLC0415

        try:
            return await hub_get_or_raise(entity_type, entity_id, action)
        except HubError as exc:
            raise _as_source_error(exc) from exc

    @staticmethod
    def _desk(source) -> str:
        desk = str((getattr(source, "config", None) or {}).get("desk_project_id") or "").strip()
        if not desk:
            raise SourceError.config("no_desk", "config.desk_project_id is required")
        return desk

    @staticmethod
    async def _ensure_identity(source) -> None:
        """Record which hub user this desk answers as, once. `self_addresses`
        reads it, and without it the projection attributes our own replies to
        a stranger and an agent answers itself."""
        if identity_stamped(source):
            return
        me = _hub_user_id()
        if not me or not hasattr(source, "save"):
            return
        await stamp_identity(source, account_key=me, identities=[me])


def _hub_user_id() -> str:
    """The logged-in hub user, or "" when signed out — the instance config's
    user pointer, the same read `load_credentials` starts from."""
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

        return str((get_user() or {}).get("id") or "")
    except Exception:  # noqa: BLE001
        return ""


def _stamp_of(fm: dict) -> str:
    return str(fm.get("updated_date") or fm.get("created_date") or "")


def _as_source_error(exc: HubError) -> SourceError:
    """Hub failure → the health that decides whether we keep polling.

    Everything with a real status goes through `SourceError.for_status` — THE
    status→health table. Named here are only the cases that table cannot know:
    no status at all (signed out / not configured vs a transport failure), and
    the two answers a desk gives a person: 401 log in, 403 you are not a member.
    """
    if exc.status_code == 0:
        return SourceError.for_no_status(exc.reason, not_configured_code="hub_not_configured")
    if exc.status_code in (401, 403):
        # The hub's authorizer answers 401 "Forbidden access" to a caller with
        # no role on the target — deliberately not distinguishing "no such
        # desk" from "not a member", so existence does not leak. With a login
        # in hand that is the membership answer; without one it is the login.
        if not _hub_user_id():
            return SourceError.config("signed_out", "Log in to Flowpad Cloud to read this desk.")
        return SourceError.config("not_a_member", "You are not a member of this desk, or it does not exist.")
    if exc.status_code == 404:
        return SourceError.config("no_desk", "This desk no longer exists on the hub.")
    return SourceError.for_status(exc.status_code, exc.reason or "")
