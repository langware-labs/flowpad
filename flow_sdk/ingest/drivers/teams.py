"""Microsoft Teams — the channel conversations a connected account can see.

The Slack driver's shape, with four differences that are not cosmetic.

**The token is refreshable, and that decided the whole connection.** A Teams
access token lasts an hour. A poll runs in a background task with no request
user, so ``credential_for`` lands on the local tier and can never read a
hub-held token — which is why this provider is registered as a LOOPBACK/PKCE
desktop grant like Google's, not a hub flow like Slack's. The refresh token
lives on this machine, where the poller can spend it.

**A channel is not addressable on its own.** Graph reaches a channel only
through its team (``/teams/{team}/channels/{channel}``), and a channel id is
not unique across teams. So a segment key here is the composite
``{teamId}/{channelId}``, and every call splits it back apart.

**Replies are a separate collection, and they are where a conversation is.**
``/messages`` returns ROOTS only. ``$expand=replies`` brings them back in the
same request, which is what makes one poll per channel enough. Teams' model is
exactly two levels — a root and its replies — so ``thread_key`` is always the
root's id, and there is no thread ambiguity of the kind Slack's ``thread_ts``
has.

**There is no incremental filter.** Graph supports neither ``$filter`` nor
``$orderby`` on channel messages; the list comes back sorted by each reply
chain's last-modified, newest chain first. So the cursor is a
``createdDateTime`` high-water mark applied HERE, after the fetch, and the page
size is what bounds the work. A channel that receives more than a page of
messages between two polls is sampled, not mirrored — the same honest limit the
Slack driver documents, arrived at from the other direction.

**What this driver cannot do: post as an agent.** Graph posts as the signed-in
user, full stop. There is no ``chat:write.customize`` equivalent — a per-message
name and avatar. Appearing as a bot with its own identity requires a registered
Teams app (Bot Framework registration, app manifest, install into the team,
usually tenant-admin approval), and even then the name and avatar are the app's,
fixed, not per-agent. So an agent bound to a Teams channel answers under the
connected account's name. That is a property of the platform, and pretending
otherwise in the UI would be the lie.
"""

from __future__ import annotations

import asyncio
import html
import logging
import re
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import (
    FetchResult,
    IngestDriver,
    SegmentCursorView,
    SegmentRef,
    SendOutcome,
    SetupVerdict,
    identity_stamped,
    segments_from_config,
    stamp_identity,
)
from flow_sdk.ingest.health import SourceError
from flow_sdk.schema.data_spec.choice_spec import Choice

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.source_item import MessageSpec

logger = logging.getLogger(__name__)

#: Graph's own base. Overridable only so a test can point at a local double.
GRAPH_API_BASE = "https://graph.microsoft.com/v1.0"

#: Root messages per poll per channel. Graph's own ceiling for this collection
#: is 50; 20 is its default. Each root arrives with its replies expanded, so a
#: page is far more than 20 messages — this is the number of CONVERSATIONS
#: looked at, and the list is ordered by which of them changed last.
MESSAGE_PAGE = 20

#: `messageType` values that are not something a person said. A join, a channel
#: rename or a team-description change is a real event, but it is not a message,
#: and every one of them would land in the inbox as a conversation entry nobody
#: wrote. Graph sends `systemEventMessage` — and `unknownFutureValue` for an
#: event type this API version has no name for, which is the same thing.
_NOT_A_MESSAGE = {"systemEventMessage", "unknownFutureValue"}

_TAG = re.compile(r"<[^>]+>")
_BREAK = re.compile(r"(?i)<br\s*/?>|</p\s*>|</div\s*>")


class TeamsDriver(IngestDriver):
    provider = "teams"
    kind = "datasource.api.teams"
    #: `content.message.*` is what the inbox projection accepts, so a Teams
    #: record lands in a conversation exactly like an email or a Slack post.
    record_kind = "content.message.chat"

    #: `POST /messages` and `/messages/{id}/replies` are the send leg. Graph
    #: echoes our own post back through the next list, so — like Slack and
    #: unlike Telegram — the driver records nothing itself; the sent copy
    #: converges on the id this returns.
    sends = True
    #: A Teams source is ABOUT its channels; each entry is `{teamId}/{channelId}`.
    identity_config_key = "channels"
    #: Read with the machine's Microsoft connection — there is no per-source key.
    connection = "microsoft"

    @classmethod
    def outbound_spec(cls, source) -> type["MessageSpec"]:
        from flow_sdk.builtin.source_item import TeamsMessageSpec  # noqa: PLC0415

        return TeamsMessageSpec

    def channel_for(self, source) -> str:
        return "teams"

    async def segments(self, source) -> list[SegmentRef]:
        """One stream per Teams channel, keyed by ``{teamId}/{channelId}``."""
        return segments_from_config(source, "channels")

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        """One page of one channel's conversations, roots and replies together.

        The cursor state is a ``createdDateTime`` high-water mark. Graph accepts
        no filter on this collection, so the floor is applied here, over
        everything the page returned — which is also why the page carries whole
        reply chains rather than a flat window: a chain that got a new reply
        comes back with its old replies too, and they are dropped by this
        comparison rather than re-ingested.
        """
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential",
                "No Microsoft credential on this machine. Connect Microsoft, then verify the source.",
            )

        team_id, channel_id = _split(cursor.segment_key)
        if not (team_id and channel_id):
            raise SourceError.config("not_found", f"`{cursor.segment_key}` is not `{{teamId}}/{{channelId}}`")
        state = dict(cursor.state or {})
        since = str(state.get("last_created") or "") or (cursor.window_start or "")

        body = await self._call(
            token,
            f"teams/{team_id}/channels/{channel_id}/messages",
            {"$top": str(MESSAGE_PAGE), "$expand": "replies"},
        )

        items: list[SourceItemSpec] = []
        newest = since
        for root in body.get("value") or []:
            # A root and its replies are one conversation, and both are records.
            # The root is listed first so a thread that arrives whole ingests in
            # the order it was said.
            for message in (root, *(root.get("replies") or [])):
                created = str(message.get("createdDateTime") or "")
                if not created or (since and created <= since):
                    continue
                newest = max(newest, created)
                if message.get("messageType") in _NOT_A_MESSAGE:
                    continue
                item = self._item(source, cursor.segment_key, root, message)
                if item is not None:
                    items.append(item)

        if not items and newest == since:
            return FetchResult(items=[], next_state=state, unchanged=True)

        # Oldest first: the storm-cap batching downstream keeps this order, and
        # a conversation read backwards is worse than one read late.
        items.sort(key=lambda i: i.occurred_at or "")
        state["last_created"] = newest
        return FetchResult(items=items, next_state=state, high_water=newest)

    def _item(self, source, segment_key: str, root: dict, message: dict) -> Optional[SourceItemSpec]:
        message_id = str(message.get("id") or "")
        if not message_id:
            return None
        root_id = str(root.get("id") or message_id)
        reply_to = str(message.get("replyToId") or "") or None
        sender = (message.get("from") or {}).get("user") or {}
        return SourceItemSpec(
            data_source_id=source.id,
            provider=self.provider,
            kind=self.record_kind,
            segment_key=segment_key,
            segment_label=segment_key,
            # A message id is unique within its channel, and the channel IS the
            # stream, so it is already the natural key.
            external_id=message_id,
            name=str(root.get("subject") or ""),
            body=_plain_text(message.get("body") or {}),
            occurred_at=str(message.get("createdDateTime") or ""),
            author_external_id=str(sender.get("id") or "") or None,
            author_display=str(sender.get("displayName") or "") or None,
            # Graph hands us the deep link; there is nothing to construct.
            permalink=str(message.get("webUrl") or "") or None,
            # Always the ROOT: Teams has exactly two levels, so a reply and its
            # root belong to one conversation and nothing nests deeper.
            thread_key=root_id,
            reply_to_external_id=reply_to,
            raw=message,
        )

    async def verify(self, source) -> SetupVerdict:
        """Can we read every configured channel?

        All-or-nothing on purpose. A source that ingests three of five channels
        is worse than one that refuses to start: it looks like it is working, so
        nobody goes looking for the two that are missing.
        """
        channels = await self.segments(source)
        if not channels:
            return SetupVerdict.waiting("No channels selected yet — pick at least one for this source to read.")

        token = await self._token(source)
        if not token:
            return SetupVerdict.waiting(
                "No Microsoft credential is available on this machine yet. Connect Microsoft first."
            )

        from flow_sdk.ingest.http import client  # noqa: PLC0415

        async with client() as http:
            errors = await asyncio.gather(*(self._read_probe(token, ref.key, http) for ref in channels))
            # The account is not in this team, or the ids are wrong: fixed by a
            # person, not by retrying. Anything else blocks the whole source.
            pending = [ref.key for ref, error in zip(channels, errors) if error == "not_found"]
            blocked = next((error for error in errors if error and error != "not_found"), None)
            if blocked == "forbidden":
                return SetupVerdict.waiting(
                    "Microsoft refused to read the channel. The connection is missing the "
                    "`ChannelMessage.Read.All` permission, or a tenant admin has not consented to it — "
                    "reconnect after an admin grants it."
                )
            if blocked:
                return SetupVerdict.waiting(f"Microsoft refused the request: {blocked}")
            await self._ensure_identity(source, token, http)

        if pending:
            names = ", ".join(pending)
            return SetupVerdict.waiting(
                f"Cannot see {names}. Join the team (or check the team/channel ids), then press Verify again.",
                pending=tuple(pending),
            )
        return SetupVerdict.ok(f"Reading {len(channels)} channel(s).")

    # ── send ──────────────────────────────────────────────────────────────

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
        """Post into a channel, under the thread the inbound message lives in.

        ``to`` is the composite ``{teamId}/{channelId}`` (the inbound record's
        ``segment_key`` — a Teams ``thread_key`` is a bare message id and names
        no channel). ``thread_key`` is the ROOT message id and routes the post
        to ``/messages/{root}/replies``; without one it is a new root, and only
        then does ``subject`` mean anything.

        The post is made AS THE CONNECTED USER. Graph offers no per-message name
        or avatar, so unlike the Slack driver this one stamps no agent persona —
        see the module docstring.

        Raises ``ValueError`` (never ``SourceError``) on a bad reply: one failed
        post must not park the channel's ingestion.
        """
        team_id, channel_id = _split(to)
        if not (team_id and channel_id):
            raise ValueError("a teams send needs `{teamId}/{channelId}` in `to`")
        if not (text or "").strip():
            raise ValueError("a teams send needs text")
        token = await self._token(source)
        if not token:
            from flow_sdk.connections import NotConnected  # noqa: PLC0415

            raise ValueError(str(NotConnected("microsoft", "Microsoft")))

        root = str(thread_key or "").strip() or str(in_reply_to or "").strip()
        path = f"teams/{team_id}/channels/{channel_id}/messages"
        payload: dict[str, Any] = {"body": {"contentType": "text", "content": text}}
        if root:
            path = f"{path}/{root}/replies"
        elif subject:
            # Only a root message carries one; Graph ignores it on a reply.
            payload["subject"] = subject

        try:
            body = await self._post(token, path, payload)
        except SourceError as exc:
            # The send contract: a refused post is the caller's problem, not the
            # source's health.
            raise ValueError(f"Microsoft refused the post: {exc}") from exc
        await self._ensure_identity(source, token)
        return SendOutcome(external_id=str(body.get("id") or ""), recorded=False)

    # ── identity ──────────────────────────────────────────────────────────

    async def _ensure_identity(self, source, token: str, http=None) -> None:
        """Stamp the connected account's own user id onto the source, once.

        Our own post comes back through the next list with ``from.user.id``
        set to this id. Stamped on ``verify`` and after a ``send`` — never on
        ``fetch``, whose per-poll budget is not for this.
        """
        if identity_stamped(source):
            return
        try:
            me = await self._call(token, "me", {}, http)
            user_id = str(me.get("id") or "").strip()
            upn = str(me.get("userPrincipalName") or "").strip()
            if not user_id:
                return
            await stamp_identity(source, account_key=upn or user_id, identities=[user_id, upn])
        except Exception:  # noqa: BLE001 — identity is a nicety; fetching must not fail on it
            logger.debug("[teams] identity stamp failed", exc_info=True)

    async def choices(self, source, field: str) -> list[Choice]:
        """The channels this account can see — the `channels` field's offer.

        Two levels, because Graph has no "every channel I can see" call: the
        teams the user has joined, then each team's channels. The id offered is
        the composite one the rest of the driver uses, so what the form stores
        is what a fetch can address.
        """
        if field != "channels":
            return []
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential", "No Microsoft credential on this machine. Connect Microsoft first."
            )
        from flow_sdk.ingest.http import client  # noqa: PLC0415

        async with client() as http:
            teams = [
                (str(team.get("id") or ""), str(team.get("displayName") or team.get("id") or ""))
                for team in (await self._call(token, "me/joinedTeams", {}, http)).get("value") or []
                if team.get("id")
            ]
            listings = await asyncio.gather(
                *(self._call(token, f"teams/{team_id}/channels", {}, http) for team_id, _ in teams)
            )
        offers: list[Choice] = []
        for (team_id, team_name), listing in zip(teams, listings):
            for channel in listing.get("value") or []:
                channel_id = str(channel.get("id") or "")
                if not channel_id:
                    continue
                offers.append(
                    Choice(
                        id=f"{team_id}/{channel_id}",
                        name=f"{team_name} / {channel.get('displayName') or channel_id}",
                        detail="private" if channel.get("membershipType") == "private" else "",
                    )
                )
        return offers

    # ── internals ─────────────────────────────────────────────────────────

    async def _token(self, source) -> Optional[str]:
        """The machine's Microsoft access token.

        No ``name`` and no bot half: Teams has no second token to hold, because
        it has no bot identity this connection can borrow.
        """
        from flow_sdk.core.oauth.provider_registry import MICROSOFT, token_for  # noqa: PLC0415

        return await token_for(MICROSOFT)

    async def _read_probe(self, token: str, segment_key: str, http=None) -> Optional[str]:
        """``None`` when the channel reads, else why it does not."""
        team_id, channel_id = _split(segment_key)
        if not (team_id and channel_id):
            return "not_found"
        try:
            await self._call(token, f"teams/{team_id}/channels/{channel_id}/messages", {"$top": "1"}, http)
        except SourceError as exc:
            return exc.code
        return None

    async def _request(self, token: str, path: str, *, verb: str, payload: dict, http=None) -> dict:
        """One Graph call on the house transport, with Graph's own message kept.

        ``ingest.http`` owns the timeout, the network and status classification.
        The three statuses a person can act on are read back here so ``verify``
        can tell a missing permission from a team the account is not in — and
        so the detail is Graph's sentence, not a bare number.
        """
        from flow_sdk.ingest.http import request  # noqa: PLC0415

        response = await request(
            http,
            verb,
            f"{GRAPH_API_BASE}/{path}",
            headers={"Authorization": f"Bearer {token}"},
            params=payload if verb == "GET" else None,
            json=payload if verb == "POST" else None,
            ok_statuses=tuple(_ERROR_CODES),
            hint="Microsoft Graph",
        )
        if response.status_code in _ERROR_CODES:
            raise SourceError.config(_ERROR_CODES[response.status_code], _why(response))
        if not response.content:
            return {}
        try:
            return response.json()
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc

    async def _call(self, token: str, path: str, params: dict, http=None) -> dict:
        return await self._request(token, path, verb="GET", payload=params, http=http)

    async def _post(self, token: str, path: str, payload: dict, http=None) -> dict:
        return await self._request(token, path, verb="POST", payload=payload, http=http)


#: The three that mean something specific to a person. `forbidden` is a
#: permission the app was never granted; `not_found` is a team or channel this
#: account cannot see; `unauthorized` is the connection itself.
_ERROR_CODES = {401: "unauthorized", 403: "forbidden", 404: "not_found"}


def _why(response) -> str:
    """Graph's own message for a failure, or the bare status."""
    try:
        error = (response.json() or {}).get("error") or {}
    except ValueError:
        error = {}
    return str(error.get("message") or "").strip() or f"HTTP {response.status_code}"


def _split(segment_key: str) -> tuple[str, str]:
    """``{teamId}/{channelId}`` -> its halves, or two empties.

    A channel id contains a colon and an ``@`` (``19:...@thread.tacv2``) but no
    slash, so one split is unambiguous.
    """
    team, _, channel = segment_key.strip().partition("/")
    return (team, channel) if team and channel else ("", "")


def _plain_text(body: dict) -> str:
    """A Teams message body as text.

    Graph sends HTML for anything typed in the client — including a bare
    sentence, which arrives wrapped in a `<div>`. The inbox stores text, and the
    agent reads what the inbox stored, so the markup is stripped here rather
    than left for every consumer to trip over. Block boundaries become newlines
    first so a multi-line post does not collapse into one line.
    """
    content = str(body.get("content") or "")
    if str(body.get("contentType") or "").lower() != "html":
        return content.strip()
    text = _BREAK.sub("\n", content)
    return html.unescape(_TAG.sub("", text)).strip()
