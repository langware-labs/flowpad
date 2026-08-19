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
from typing import Any, Optional

from flow_sdk.ingest.driver import FetchResult, SetupVerdict, SegmentCursorView, SegmentRef
from flow_sdk.ingest.health import SourceError
from flow_sdk.ingest.models import IngestItem

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


class SlackDriver:
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

    def channel_for(self, source) -> str:
        return "slack"

    def segments(self, source) -> list[SegmentRef]:
        """One stream per Slack channel.

        Keyed by channel ID, never by name: a renamed channel is the same
        channel, and keying on the name would fork its history. `segment_label`
        carries the display name and self-heals on each poll.
        """
        config = getattr(source, "config", None) or {}
        channels = config.get("channels") or []
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

        items: list[IngestItem] = []
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
                IngestItem(
                    source_id=source.id,
                    provider=self.provider,
                    kind=self.record_kind,
                    segment_key=cursor.segment_key,
                    segment_label=cursor.segment_key,
                    # `ts` is unique within a channel and the channel IS the
                    # stream, so it is already the natural key.
                    external_id=ts,
                    title="",
                    body=str(message.get("text") or ""),
                    occurred_at=_iso(ts),
                    author_external_id=str(message.get("user") or message.get("bot_id") or "")
                    or None,
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
        channels = self.segments(source)
        if not channels:
            return SetupVerdict.waiting(
                "No channels selected yet — pick at least one for this source to read."
            )

        token = await self._token(source)
        if not token:
            return SetupVerdict.waiting(
                "No Slack credential is available on this machine yet. Connect Slack first."
            )

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

        if pending:
            names = ", ".join(f"#{labels.get(key, key)}" for key in pending)
            return SetupVerdict.waiting(
                f"Invite the Flowpad bot to {names}, then press Verify again.",
                pending=tuple(pending),
            )
        return SetupVerdict.ok(f"Reading {len(channels)} channel(s).")

    # ── internals ─────────────────────────────────────────────────────────

    async def _call(self, token: str, method: str, params: dict) -> dict:
        """A Slack Web API GET, with Slack's failure convention translated.

        Slack answers 200 with `{"ok": false, "error": …}`, so the status code
        alone never says whether a call worked — every caller would have to
        remember that, and the one that forgets reports a revoked token as a
        successful empty page.
        """
        import httpx  # noqa: PLC0415

        from flow_sdk.ingest.http import REQUEST_TIMEOUT_SECONDS  # noqa: PLC0415

        try:
            async with httpx.AsyncClient(timeout=REQUEST_TIMEOUT_SECONDS) as client:
                response = await client.get(
                    f"{SLACK_API_BASE}/{method}",
                    params=params,
                    headers={"Authorization": f"Bearer {token}"},
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
                f"The bot is not in {params.get('channel')}. Invite it, then press Verify.",
            )
        raise SourceError.config(error, f"Slack refused the request: {error}")

    async def _token(self, source) -> Optional[str]:
        """This machine's Slack token. The precedence lives in one place."""
        from flow_sdk.core.oauth.provider_registry import SLACK, token_for  # noqa: PLC0415

        return await token_for(SLACK)

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
