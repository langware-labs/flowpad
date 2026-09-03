"""Slack — the channels a bot has actually been let into.

Two halves: which channels a source is configured for and whether the app can
really read each one (`verify`), and what has been said in one since we last
looked (`fetch`).

**The rate cap shapes the whole driver.** Since 2025-05-29 Slack allows a
non-Marketplace app ONE `conversations.history` request per minute, returning at
most 15 messages. That is not a detail to tune around — it is the reason this
driver reads one page per stream per poll and never paginates, and the reason
`segment_budget` is 1 so a source with five channels visits one channel per tick
instead of spending five requests inside a one-request minute. A busy channel is
therefore sampled, not mirrored; the Events API is the answer to that, and it is
a separate piece of work. What is here is honest about which it is.

**Why verification is a first-class step for this provider.** Slack refuses to
let an app read a channel the bot was never invited to, and nothing we can
configure changes that — `conversations.join` works for public channels, but a
private one requires a human to invite the bot from inside Slack. So a Slack
source is not "broken" between being created and being invited; it is unfinished,
and that is a state the user has to be able to see and act on.

The check is one `conversations.history` call per channel with `limit=1`. That
is the cheapest question that has the right answer: scopes, membership and token
validity all show up in it, and a channel we cannot read returns `not_in_channel`
rather than an empty page.
"""

from __future__ import annotations

import logging
from datetime import datetime, timezone
from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.builtin.source_item import SourceItemSpec
from flow_sdk.ingest.driver import FetchResult, IngestDriver, SegmentCursorView, SegmentRef, SendOutcome, SetupVerdict
from flow_sdk.ingest.health import SourceError
from flow_sdk.schema.data_spec.choice_spec import Choice

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.source_item import MessageSpec

logger = logging.getLogger(__name__)

#: Slack's own base. Overridable only so a test can point at a local double.
SLACK_API_BASE = "https://slack.com/api"

#: What Slack says when the bot is not in the channel. The distinction matters:
#: this is a setup problem, while `invalid_auth` is a connection problem and
#: `missing_scope` is an app-configuration problem. Reporting all three as "not
#: working" would send the user to the wrong place three times out of three.
NOT_A_MEMBER = {"not_in_channel", "channel_not_found"}

#: Slack's own ceiling for a non-Marketplace app: 15 objects per
#: `conversations.history` call, one call per minute. Asking for more is not
#: rejected, it is silently truncated — so the number is written here rather
#: than left implicit, and no pagination follows it.
HISTORY_PAGE = 15

#: Slack error codes that mean "wait", not "you are misconfigured". Everything
#: else this driver sees is a config problem, which parks the source until a
#: person looks at it — the right outcome for a revoked token, the wrong one for
#: a throttle.
TRANSIENT_ERRORS = {"ratelimited", "rate_limited", "service_unavailable", "internal_error"}


class SlackDriver(IngestDriver):
    provider = "slack"
    kind = "datasource.api.slack"
    #: `content.message.*` is what the inbox projection accepts, so a Slack
    #: record lands in a conversation exactly like an email does.
    record_kind = "content.message.chat"

    #: Channels visited per poll. ONE, because the whole source shares a
    #: one-request-per-minute budget: with the default round-robin (5) a
    #: five-channel source would spend five requests inside a minute that allows
    #: one, and Slack would 429 four of them. `sync_source` round-robins by
    #: `last_attempted_at`, so every channel is still reached — one per tick.
    segment_budget = 1

    #: ``chat.postMessage`` is the send leg. Slack DOES echo a bot's own post
    #: back through ``conversations.history``, so unlike Telegram the driver
    #: records nothing itself — the next poll ingests the sent copy and it
    #: converges on the ``ts`` this returns.
    sends = True
    #: A Slack source is ABOUT its channels; ``blocks.Inbox("C0123…",
    #: provider="slack")`` reuses the source whose ``channels`` carry that id.
    identity_config_key = "channels"
    #: Read with the machine's Slack connection — there is no per-source key.
    connection = "slack"

    @classmethod
    def outbound_spec(cls, source) -> type["MessageSpec"]:
        from flow_sdk.builtin.source_item import SlackMessageSpec  # noqa: PLC0415

        return SlackMessageSpec

    def channel_for(self, source) -> str:
        return "slack"

    async def segments(self, source) -> list[SegmentRef]:
        """One stream per Slack channel.

        Keyed by channel ID, never by name: a renamed channel is the same
        channel, and keying on the name would fork its history. `segment_label`
        carries the display name and self-heals on each poll.
        """
        config = getattr(source, "config", None) or {}
        channels = config.get("channels") or []
        # A `lines` field arrives as a bare string from a caller that bypassed
        # the form (``blocks.Inbox`` names ONE channel); iterating it would
        # yield its characters as channel ids.
        if isinstance(channels, str):
            channels = [line for line in channels.splitlines() if line.strip()]
        refs: list[SegmentRef] = []
        for entry in channels:
            if isinstance(entry, dict):
                key = str(entry.get("id") or "").strip()
                label = str(entry.get("name") or key)
            else:
                key = str(entry).strip()
                label = key
            if key:
                refs.append(SegmentRef(key=key, label=label))
        return refs

    async def fetch(self, source, cursor: SegmentCursorView) -> FetchResult:
        """One page of one channel, from where we left off.

        The cursor state is a single Slack `ts` — which is both a timestamp and
        a message id, so it is the natural resume point and needs no separate
        high-water bookkeeping. `oldest` is exclusive on Slack when
        `inclusive=false`, so the last message read is never re-fetched.

        On the first run there is no `ts` yet and `window_start` supplies the
        floor, which is what stops a new source pulling a channel's whole
        history on the tick it is created.
        """
        token = await self._token(source)
        if not token:
            raise SourceError.config(
                "no_credential",
                "No Slack credential on this machine. Connect Slack, then verify the source.",
            )

        state = dict(cursor.state or {})
        oldest = state.get("last_ts") or _epoch_str(cursor.window_start)
        params: dict[str, Any] = {
            "channel": cursor.segment_key,
            "limit": HISTORY_PAGE,
            "inclusive": "false",
        }
        if oldest:
            params["oldest"] = oldest

        body = await self._call(token, "conversations.history", params)
        # Slack returns newest-first. Reverse so a page ingests in the order it
        # was said — the storm-cap batching downstream keeps that order, and a
        # conversation read backwards is worse than one read late.
        messages = list(reversed(body.get("messages") or []))
        if not messages:
            return FetchResult(items=[], next_state=state, unchanged=True)

        items: list[SourceItemSpec] = []
        newest = oldest or ""
        for message in messages:
            ts = str(message.get("ts") or "")
            if not ts:
                continue
            # Joins, leaves, channel renames. They are real events but they are
            # not messages, and every one of them would land in the inbox as a
            # conversation entry nobody wrote.
            if message.get("subtype") in _NOT_A_MESSAGE:
                newest = max(newest, ts, key=_ts_key)
                continue

            thread_ts = str(message.get("thread_ts") or "") or None
            items.append(
                SourceItemSpec(
                    data_source_id=source.id,
                    provider=self.provider,
                    kind=self.record_kind,
                    segment_key=cursor.segment_key,
                    segment_label=cursor.segment_key,
                    # `ts` is unique within a channel and the channel IS the
                    # stream, so it is already the natural key.
                    external_id=ts,
                    name="",
                    body=str(message.get("text") or ""),
                    occurred_at=_iso(ts),
                    author_external_id=str(message.get("user") or message.get("bot_id") or "") or None,
                    author_display=str(message.get("username") or "") or None,
                    permalink=_permalink(cursor.segment_key, ts),
                    # A threaded reply carries its parent's ts; a top-level
                    # message is its own thread root. Either way the whole
                    # thread converges on one conversation.
                    thread_key=thread_ts or ts,
                    reply_to_external_id=thread_ts if thread_ts and thread_ts != ts else None,
                    raw=message,
                )
            )
            newest = max(newest, ts, key=_ts_key)

        state["last_ts"] = newest
        return FetchResult(items=items, next_state=state, high_water=_iso(newest))

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
            return SetupVerdict.waiting("No Slack credential is available on this machine yet. Connect Slack first.")

        pending: list[str] = []
        labels: dict[str, str] = {c.key: c.label for c in channels}
        blocked_reason: Optional[str] = None

        for ref in channels:
            error = await self._read_probe(token, ref.key)
            if error is None:
                continue
            if error in NOT_A_MEMBER:
                pending.append(ref.key)
                continue
            # Not a membership problem — a scope or token problem, which no
            # amount of inviting will fix. Report it as itself.
            blocked_reason = error
            break

        if blocked_reason == "missing_scope":
            return SetupVerdict.waiting(
                "The Slack app is missing the history permission. It needs "
                "`channels:history` (and `groups:history` for private channels); "
                "an admin has to add it and everyone reconnects."
            )
        if blocked_reason:
            return SetupVerdict.waiting(f"Slack refused the request: {blocked_reason}")

        # Reading works: now is the cheap moment to learn who "me" is. Not in
        # ``fetch`` — that runs on a one-request-per-minute budget.
        await self._ensure_identity(source, token)

        if pending:
            names = ", ".join(f"#{labels.get(key, key)}" for key in pending)
            return SetupVerdict.waiting(
                f"Invite the Flowpad bot to {names}, then press Verify again.",
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
        """Post into a channel, in the thread the inbound message lives in.

        ``to`` is the CHANNEL id (the inbound record's ``segment_key`` — a
        Slack ``thread_key`` is a bare ``ts`` and does not name the channel).
        ``thread_key`` becomes ``thread_ts`` so the reply lands in the thread
        rather than as a new top-level post; a top-level inbound message is its
        own thread root, so replying "to its thread" is replying to it.
        ``subject`` has no Slack equivalent and is ignored by design.

        Raises ``ValueError`` (never ``SourceError``) on a bad reply: one
        failed post must not park the channel's ingestion.
        """
        channel = str(to or "").strip()
        if not channel:
            raise ValueError("a slack send needs the channel id in `to`")
        if not (text or "").strip():
            raise ValueError("a slack send needs text")
        token = await self._token(source)
        if not token:
            from flow_sdk.connections import NotConnected  # noqa: PLC0415

            raise ValueError(str(NotConnected("slack", "Slack")))

        payload: dict[str, Any] = {"channel": channel, "text": text}
        thread_ts = str(thread_key or "").strip() or str(in_reply_to or "").strip()
        if thread_ts:
            payload["thread_ts"] = thread_ts

        # Post AS the agent that owns this source, when one does. Resolved from
        # the source rather than threaded through `send` — the same key and the
        # same rule the INBOUND half already uses (`_agent_sender_for`), so one
        # agent reads as one identity on both sides of the conversation.
        # Requires the `chat:write.customize` scope: without it Slack accepts
        # the post and silently ignores both fields.
        from flow_sdk.inbox.sender_identity import sender_identity  # noqa: PLC0415

        identity = await sender_identity(source)
        if identity is not None:
            if identity.username:
                payload["username"] = identity.username
            if identity.icon_emoji:
                payload["icon_emoji"] = identity.icon_emoji
        try:
            body = await self._post(token, "chat.postMessage", payload)
        except SourceError as exc:
            # The send contract: a refused post is the caller's problem, not
            # the source's health.
            raise ValueError(f"Slack refused the post: {exc}") from exc
        await self._ensure_identity(source, token)
        return SendOutcome(external_id=str(body.get("ts") or ""), recorded=False)

    # ── identity ──────────────────────────────────────────────────────────

    async def _ensure_identity(self, source, token: str) -> None:
        """Stamp the bot's own user id onto the source, once.

        ``self_addresses`` reads ``account_identities``; a bot's post comes
        back through ``conversations.history`` with ``user`` set to its user
        id, and without that id stamped here the inbox would attribute our
        own replies to a foreign sender and a ``blocks.Inbox`` loop would
        answer itself. Stamped on ``verify`` and after a ``send`` — never on
        ``fetch``, whose one-request-per-minute budget is not for this.
        """
        if getattr(source, "account_key", "") or getattr(source, "account_identities", None):
            return
        try:
            me = await self._call(token, "auth.test", {})
            user_id = str(me.get("user_id") or "").strip()
            bot_id = str(me.get("bot_id") or "").strip()
            handle = str(me.get("user") or "").strip()
            if not (user_id or bot_id):
                return
            source.account_key = f"@{handle}" if handle else user_id
            source.account_identities = [v for v in (user_id, bot_id, f"@{handle}" if handle else "") if v]
            await source.save()
        except Exception:  # noqa: BLE001 — identity is a nicety; fetching must not fail on it
            logger.debug("[slack] auth.test identity stamp failed", exc_info=True)

    async def choices(self, source, field: str) -> list[Choice]:
        """The channels this token can see — the `channels` field's offer.

        `channels:read` / `groups:read` are already in the app's granted set, so this
        needs no new consent and no change to the hub that owns that list.

        It offers every channel the token can SEE, not only those the bot has joined.
        Discovery is the point: "not a member yet" is a normal SETUP state this driver
        already reports and the person fixes with an invite, so pre-filtering would hide
        exactly the channel they opened the form to add.
        """
        if field != "channels":
            return []
        token = await self._token(source)
        if not token:
            raise SourceError.config("no_credential", "No Slack credential on this machine. Connect Slack first.")
        body = await self._call(
            token,
            "conversations.list",
            {"types": "public_channel,private_channel", "exclude_archived": "true", "limit": "200"},
        )
        return [
            Choice(
                id=str(c["id"]),
                name=str(c.get("name") or c["id"]),
                detail="private" if c.get("is_private") else "",
            )
            for c in body.get("channels") or []
            if c.get("id")
        ]

    # ── internals ─────────────────────────────────────────────────────────

    async def _request(
        self,
        token: str,
        method: str,
        *,
        verb: str,
        payload: dict,
    ) -> dict:
        """One Slack Web API call with the provider's shared failure translation."""
        import httpx  # noqa: PLC0415

        from flow_sdk.ingest.http import REQUEST_TIMEOUT_SECONDS  # noqa: PLC0415

        request_data = {"json": payload} if verb == "POST" else {"params": payload}
        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.request(
                    verb,
                    f"{SLACK_API_BASE}/{method}",
                    headers={"Authorization": f"Bearer {token}"},
                    **request_data,
                )
        except httpx.HTTPError as exc:
            raise SourceError.transient("network_error", str(exc)) from exc
        try:
            body = response.json()
        except ValueError as exc:
            raise SourceError.transient("bad_json", str(exc)) from exc
        if body.get("ok"):
            return body
        error = str(body.get("error") or f"http_{response.status_code}")
        if error in TRANSIENT_ERRORS:
            raise SourceError.transient(error, f"Slack: {error}")
        if error in NOT_A_MEMBER:
            raise SourceError.config(
                error,
                f"The bot is not in {payload.get('channel')}. Invite it, then press Verify.",
            )
        raise SourceError.config(error, f"Slack refused the request: {error}")

    async def _post(self, token: str, method: str, json_body: dict) -> dict:
        return await self._request(token, method, verb="POST", payload=json_body)

    async def _call(self, token: str, method: str, params: dict) -> dict:
        """A Slack Web API GET, with Slack's failure convention translated.

        Slack answers 200 with `{"ok": false, "error": …}`, so the status code
        alone never says whether a call worked — every caller would have to
        remember that, and the one that forgets reports a revoked token as a
        successful empty page.
        """
        return await self._request(token, method, verb="GET", payload=params)

    async def _token(self, source) -> Optional[str]:
        """This machine's Slack token — the BOT's, when we hold it.

        The bot is who this driver should be. `_ensure_identity` was written to
        stamp a bot's user id, `chat.postMessage` posts as whoever the token is,
        and an inbound message from the human only reads as an external sender —
        the thing that makes a reply addressable at all — when we are NOT that
        human. With the user token the app IS the authorizing person, so their
        own messages fold into "ours" and `outbound.py` refuses to reply.

        Falls back to the user token so an instance that connected before the
        bot half was adopted keeps working, degraded rather than broken. That
        fallback costs a second credential resolution per poll on such an
        instance — a `User.get_local()` read and a SOD decrypt — which is the
        price of not breaking it. An instance that has adopted the bot pays
        exactly what it paid before, because the first lookup hits.
        """
        from flow_sdk.core.oauth.provider_registry import (  # noqa: PLC0415
            SLACK,
            app_credentials_name,
            token_for,
        )

        bot_name = app_credentials_name(SLACK)
        bot = await token_for(SLACK, name=bot_name) if bot_name else None
        return bot or await token_for(SLACK)

    async def _read_probe(self, token: str, channel: str) -> Optional[str]:
        """None when the channel is readable, else Slack's error code.

        `limit=1` because the question is "may I read this", not "what is in
        it" — and on a 1-request-per-minute budget the cheapest possible call is
        the only responsible one.
        """
        import httpx  # noqa: PLC0415

        from flow_sdk.ingest.http import REQUEST_TIMEOUT_SECONDS  # noqa: PLC0415

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    f"{SLACK_API_BASE}/conversations.history",
                    params={"channel": channel, "limit": 1},
                    headers={"Authorization": f"Bearer {token}"},
                )
        except httpx.HTTPError as exc:
            return f"network_error: {exc}"

        # Slack answers 200 with {"ok": false, "error": ...} — the status code
        # alone never says whether this worked.
        body: dict[str, Any] = {}
        try:
            body = response.json()
        except ValueError:
            return f"http_{response.status_code}"
        if body.get("ok"):
            return None
        return str(body.get("error") or f"http_{response.status_code}")


#: Subtypes that are channel bookkeeping rather than something someone said.
_NOT_A_MESSAGE = {
    "channel_join",
    "channel_leave",
    "channel_topic",
    "channel_purpose",
    "channel_name",
    "channel_archive",
    "channel_unarchive",
}


def _ts_key(ts: str) -> float:
    """Slack `ts` ordered numerically — "10.5" must not sort below "9.5"."""
    try:
        return float(ts)
    except (TypeError, ValueError):
        return 0.0


def _iso(ts: str) -> Optional[str]:
    """Slack `ts` ("1712345678.000200") → ISO-8601, or None if it is not one."""
    seconds = _ts_key(ts)
    if not seconds:
        return None
    return datetime.fromtimestamp(seconds, tz=timezone.utc).isoformat()


def _epoch_str(iso: Optional[str]) -> Optional[str]:
    """An ISO window floor → the epoch string Slack's `oldest` expects."""
    if not iso:
        return None
    try:
        return f"{datetime.fromisoformat(iso.replace('Z', '+00:00')).timestamp():.6f}"
    except (TypeError, ValueError):
        return None


def _permalink(channel: str, ts: str) -> str:
    """A link into Slack without knowing the workspace domain.

    `app_redirect` resolves the workspace from the signed-in client, so this is
    a pure formula. That matters more than prettiness: `permalink` is a DIGESTED
    field, so a value that needed a `chat.getPermalink` call would spend a
    request per message against a one-request-per-minute budget, and any drift
    in it would rewrite the entire corpus on the next poll.
    """
    return f"https://slack.com/app_redirect?channel={channel}&message_ts={ts}"
