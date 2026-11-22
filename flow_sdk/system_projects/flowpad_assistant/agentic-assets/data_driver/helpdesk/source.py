"""``HelpdeskSource`` — a hub desk's tickets as a message source.

A ticket is a hub conversation (``kind=helpdesk``): a guest opens it against a desk project, staff
*pick it up* to join, and every reply is an ordinary hub message the hub masks to the desk's
brand. The source is ONE desk-wide stream: the pool says which tickets moved, a ticket's messages
are the records, a reply is ``send``.

**Both writers, one row.** A ticket's messages also reach this machine through the hub mirror
once the owner is a participant, so every record carries the hub's own ids
(``hub_conversation_id`` / ``hub_message_id``): the application adopts the mirrored rows instead
of minting twins.

**The hub is Flowpad's own backend, reached through a transport.** Its auth, token refresh and
local-privacy gate belong to whoever holds the login, so the source takes a ``HubTransport``
rather than a credential: the application passes the one it already has; a source host hands over
its backend's. Without one, every call is ``SourceUnavailable``.

**One cursor for the desk.** Each pool row carries a change token (``message_count:updated_at:status``);
the cursor remembers, per ticket, the token it was last read at and its own message resume point,
plus the pool's watermark. A pass reads messages only of tickets whose token moved, and of tickets
it has never seen — so an idle ticket costs no fetch.

**No ``since`` on the hub's messages.** A ticket's resume point is a watermark on ``updated_date``
plus the ids seen AT it (a burst can share a second); an edited message re-arrives because its
stamp moved.
"""

from __future__ import annotations

from typing import Annotated, Any, ClassVar, Union

from pydantic import StringConstraints

from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import ChoiceEntry, SourceConfig
from flow_sdk.sources.errors import Rejected
from flow_sdk.sources.hub_conversations import (
    HubConversationSource,
    HubMessageData,
    HubTransport,
    PoolEntry,
    change_token,
    newest_first,
    rows_of,
)
from flow_sdk.sources.values.origin import CloudOrigin

#: The channel a ticket is: half the thread key, so it names what a ticket IS.
CHANNEL = "helpdesk"


class HelpdeskMessageData(HubMessageData):
    spec_kind: ClassVar[str] = "ingest.message.helpdesk"


#: A desk this login holds no role on: a source reading it would see no tickets and raise no error.
NOT_ON_DESK = "you are not on this desk's team, so its tickets will not show"


class HelpdeskConfig(SourceConfig):
    """What a helpdesk source is configured with."""

    desk_project_id: Union[Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)], ChoiceEntry]


class HelpdeskSource(HubConversationSource):
    Config = HelpdeskConfig
    provider = "helpdesk"
    origin_kind = CHANNEL
    cursor_prefix = "desk:"
    label = "help-desk"
    noun = "ticket"
    data_cls = HelpdeskMessageData
    #: Strangers are the point: an empty allowlist admits every requester.
    open_inbound = True
    #: A turn's text goes back to the customer only the first time (the acknowledgement); every later word
    #: to them is an explicit reply that the team approved.
    answers_once: ClassVar[bool] = True
    identity_config_key = "desk_project_id"
    #: Every thread here is a help-desk ticket.
    conversation_kind = "helpdesk"

    @property
    def desk(self) -> str:
        entry = self.config.get("desk_project_id") or ""
        return str((entry.get("id") if isinstance(entry, dict) else entry) or "").strip()

    @property
    def root(self) -> str:
        return self.desk or CHANNEL

    def ticket_origin(self, ticket: str) -> CloudOrigin:
        return self.conversation_origin(ticket)

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def build(cls, binding: SourceBinding) -> "HelpdeskSource":
        from .transport import AppHub  # noqa: PLC0415

        return cls(binding, hub=AppHub())

    @classmethod
    async def choices_for(cls, row: Any, field: str) -> list:
        """The desks known here: the deployment's default desk and every desk adopted into a local
        project. Application state, not the hub's — so it is read from the application. A desk this login
        is not on is still offered, with a warning: its tickets stay hidden from a source that reads it.
        Typing an id still works."""
        from flow_sdk.app.actions.flow_message_action import resolve_helpdesk  # noqa: PLC0415
        from flow_sdk.builtin.helpdesk import Helpdesk  # noqa: PLC0415
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.schema.data_spec.choice_spec import Choice  # noqa: PLC0415

        if field != "desk_project_id":
            return []
        known: list[tuple[str, str, str]] = []
        default = await resolve_helpdesk()
        if default is not None:
            known.append((default.project_id, "Flowpad Support", "the deployment's default desk"))
        try:
            desks = await Helpdesk.get_all({})
        except Exception:  # noqa: BLE001 — no adopted desks is not a failure
            desks = []
        for desk in desks or []:
            queue = str(getattr(desk, "desk_project_id", "") or "").strip()
            if queue and all(k[0] != queue for k in known):
                known.append((queue, str(getattr(desk, "display_name", "") or queue), "adopted desk"))
        if not known:
            return []
        walk = await HubProxy.walk("project")
        reachable = {str(p.get("id") or "") for p in walk.rows if (p.get("helpdesk") or {}).get("enabled")}
        return [
            Choice(id=key, name=name, detail=detail if not walk.complete or key in reachable else NOT_ON_DESK)
            for key, name, detail in known
        ]

    @classmethod
    async def ensure_sources(cls) -> int:
        """One help-desk source per desk this login staffs: a hub project it holds a role on whose help
        desk is on. A ticket reaches its staff only through such a source (they are not in it), so a
        staffer never has to connect their own desk by hand. Returns how many were made."""
        from flow_sdk.assets.creation import AssetPathCollisionError  # noqa: PLC0415
        from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
        from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
        from flow_sdk.cloud_client.hub_proxy import HubProxy  # noqa: PLC0415
        from flow_sdk.ingest.health import SourceHealth  # noqa: PLC0415

        walk = await HubProxy.walk("project")
        driver = DataDriver.loaded(cls.provider)
        if not walk.complete or driver is None:
            return 0
        made = 0
        for project in walk.rows:
            desk = project.get("helpdesk") or {}
            desk_id = str(project.get("id") or "").strip()
            if not desk.get("enabled") or not desk_id:
                continue
            held = await DataSource.find_for_account(cls.provider, cls.identity_config_key, desk_id)
            if held is not None:
                # This walk just succeeded with a login that holds a role on the desk, so a source parked by an
                # earlier 401 (the hub restarted or the login lapsed) is no longer a configuration error.
                if held.error_code == "access_denied" and held.health == SourceHealth.CONFIG_ERROR:
                    await held.poll_now()
                continue
            name = str(desk.get("display_name") or project.get("name") or desk_id)
            config = driver.create_config(**{cls.identity_config_key: desk_id})
            try:
                await driver.create_source(config, name=name).save()
            except AssetPathCollisionError:
                # Two desks may share a name (a source's folder is named by it): the second is told apart by
                # its id, or its staff would never receive its tickets.
                await driver.create_source(config, name=f"{name} ({desk_id[:8]})").save()
            made += 1
        return made

    # ── read: the desk ──────────────────────────────────────────────────────
    def require_ready(self) -> None:
        if not self.desk:
            raise Rejected("This help-desk source needs its desk (config.desk_project_id).")

    async def _read_pool(self) -> list[PoolEntry]:
        """Every ticket in the pool, picked up or not, newest activity first."""
        self.require_ready()
        rows = rows_of(
            await self.hub.get("project", self.desk, "helpdesk_conversations", params={"include_closed": "true"})
        )
        pool = []
        for row in rows:
            ticket = str(row.get("conversation_id") or "").strip()
            if ticket:
                updated_at = str(row.get("updated_at") or "")
                pool.append(
                    PoolEntry(ticket, change_token(row.get("message_count"), updated_at, row.get("status")), updated_at)
                )
        return newest_first(pool)

    # ── send: pick up, then answer ──────────────────────────────────────────
    async def prepare_answer(self, conversation: str) -> None:
        """Pick the ticket up before the post. The hub fans a ticket out to participants only, so pickup
        is what makes the answer (and the guest's next word) reach this machine; the hub makes a second
        pickup a no-op, so it is always sent rather than paid for with a read first."""
        await self.hub.post("conversation", {}, conversation, "pickup")


__all__ = ["CHANNEL", "HelpdeskMessageData", "HelpdeskSource", "HubTransport"]
