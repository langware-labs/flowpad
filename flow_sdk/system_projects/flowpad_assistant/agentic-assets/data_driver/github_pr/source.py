"""``GithubPrSource`` — the open pull requests assigned to you (or awaiting your review), each a conversation.

**A PR is the conversation; what happens on it is the messages.** Issue comments, review comments,
reviews, the timeline's assignments, pushes, merges, closes and reopens, and one CI summary for the
head commit. The conversation is ``(github_pr, <account>, <owner>/<repo>#<n>)``; a message is
``(github_pr, <account>/<owner>/<repo>#<n>, <kind>-<id>)``, keyed on GitHub's own object id per kind
(``comment-`` an issue comment, ``review-comment-`` a review comment, ``review-``, ``event-``,
``commit-<sha>``, ``check-<head sha>``) — ids GitHub never reuses, so a key is unique across PRs.

**The cursor is a high-water mark on ``updated``.** The search (``is:pr is:open assignee:@me``)
is read sorted by ``updated`` ascending, a search page at a time; the resume cursor carries the
newest ``updated`` seen and the next pass narrows to ``updated:>=<mark>``. A PR seen again yields
the same keys, so re-reading is free (the application's digest absorbs it).

**A page is a slice of items, not of PRs.** One PR is many messages, so a continuation carries the
search page AND how many of its items were handed out already.

**403 is two things on GitHub.** A rate limit (``X-RateLimit-Remaining: 0`` or ``Retry-After``) is
"wait" — the next pass retries; any other 403 is a refusal.

Polling only: webhooks (``pull_request``, ``issue_comment``, ``check_suite``) are a later piece of work.
"""
from __future__ import annotations

import asyncio
import base64
import binascii
import json
import re
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, ClassVar, Literal, Mapping, Optional, Union

from flow_sdk.sources import http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import ChoiceEntry, SourceConfig
from flow_sdk.sources.errors import AccessDenied, InvalidCursor, NotFound, SourceError, SourceUnavailable, Unsupported
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.memory import check_outgoing
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import MessageData, MessageItem, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import MessageQuery

GITHUB_API_BASE = "https://api.github.com"
#: PRs per search page, and the per-PR list size (one page of each list per PR).
SEARCH_PAGE = 30
LIST_PAGE = 100
#: The scopes the connection must carry; ``X-OAuth-Scopes`` names what a classic token holds.
REQUIRED_SCOPES = ("repo", "read:org")
MAX_CURSOR_LENGTH = 4096
FILTERS = {"assigned": "assignee", "review_requested": "review-requested"}
#: PRs read at once in one search page.
PR_CONCURRENCY = 6
SIGN_IN = "GitHub sign-in is missing or expired"

_PR = re.compile(r"^[^/#\s]+/[^/#\s]+#\d+$")
_MESSAGE = re.compile(r"^(comment|review-comment|review|event|commit|check)-[\w.-]+$")
#: Timeline events that are messages; the rest (labels, mentions, renames) are bookkeeping.
_EVENTS = frozenset({"assigned", "committed", "head_ref_force_pushed", "merged", "closed", "reopened"})
#: A check that finished without failing.
_GREEN = frozenset({"success", "neutral", "skipped"})


class GithubPrMessageData(MessageData):
    spec_kind: ClassVar[str] = "ingest.message.github_pr"
    volatile: ClassVar[frozenset[str]] = frozenset({"raw"})

    #: The PR's title — the conversation's subject.
    subject: Optional[str] = None
    raw: Optional[dict] = None


class GithubPrConfig(SourceConfig):
    """What a github_pr source is configured with."""

    filter: Union[Literal["assigned", "review_requested"], ChoiceEntry] = "assigned"
    #: ``owner/repo`` each; empty reads every repository the token reaches.
    repos: list[str] = []
    #: Empty is GitHub itself; a test points a row at a local double. Never a secret.
    base_url: str = GITHUB_API_BASE


class GithubPrSource(MessageSource):

    Config = GithubPrConfig
    provider = "github_pr"
    connection = "github"
    durable_cursor = True
    #: A normal pass hands out a whole search page of PRs at once.
    page_size = MAX_PAGE_SIZE
    #: A reply lands in the PR (or the review thread); it never quotes.
    quotes = False

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    # ── config ──────────────────────────────────────────────────────────────
    @property
    def base_url(self) -> str:
        return str(self.config.get("base_url") or GITHUB_API_BASE).rstrip("/")

    @property
    def filter(self) -> str:
        entry = self.config.get("filter") or "assigned"
        value = str(entry.get("id") if isinstance(entry, dict) else entry)
        return value if value in FILTERS else "assigned"

    @property
    def repos(self) -> list[str]:
        return [r.strip() for r in self.config.get("repos") or () if str(r).strip()]

    def query(self) -> MessageQuery:
        return MessageQuery()

    def conversation_origin(self, pr: str) -> CloudOrigin:
        """``<owner>/<repo>#<n>``'s conversation."""
        return self.origin(pr)

    async def choices(self, field: str) -> list[dict]:
        if field != "filter":
            return []
        return [{"id": "assigned", "name": "Assigned to you"}, {"id": "review_requested", "name": "Your review is requested"}]

    # ── what the application asks ───────────────────────────────────────────
    @classmethod
    def outbound_spec(cls) -> type:
        # The PR is the address: a reply goes to the thread, never to its author.
        from flow_sdk.builtin.source_item import HelpdeskMessageSpec  # noqa: PLC0415

        return HelpdeskMessageSpec

    def message_for(self, *, thread_key: str, to: str, text: str, subject: str = "", in_reply_to: str = "", conversation_id: str = ""):
        """``to`` (or ``thread_key``) is the PR, ``<owner>/<repo>#<n>``. ``in_reply_to`` — a message
        key this source handed out — makes it a reply, which a review comment answers in its thread.
        A subject has no GitHub equivalent."""
        pr = str(thread_key or "").strip() or str(to or "").strip()
        if not _PR.match(pr):
            raise ValueError("a github_pr send needs the PR as `<owner>/<repo>#<n>` in `to` or `thread_key`")
        answered = str(in_reply_to or "").strip()
        if answered:
            return MessageData(text=text), self.origin(answered, pr)
        return MessageData(text=text, conversation=self.conversation_origin(pr)), None

    # ── session ─────────────────────────────────────────────────────────────
    async def _open(self) -> None:
        self._client = http.client()

    async def _close(self) -> None:
        if self._client is not None:
            await self._client.aclose()
            self._client = None

    # ── read ────────────────────────────────────────────────────────────────
    async def fetch(
        self, cursor: Optional[str] = None, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> ChangePage:
        self._require_open()
        query = self.effective_query(narrow)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        page, skip, top = 1, 0, None
        if cursor is None:
            since = query.since if query is not None else None
        else:
            state = _decode(cursor)
            since = _stamp(state.get("mark"))
            if "page" in state:
                page, skip, top = int(state["page"]), int(state.get("skip") or 0), _stamp(state.get("top"))

        found = await self._get("/search/issues", q=self._search(since), sort="updated", order="asc", per_page=SEARCH_PAGE, page=page)
        prs = [pr for pr in found.get("items") or () if isinstance(pr, dict) and pr.get("number") and pr.get("repository_url")]
        gate = asyncio.Semaphore(PR_CONCURRENCY)

        async def read(pr: dict) -> list[MessageItem]:
            async with gate:
                return await self._messages(pr)

        items = [item for messages in await asyncio.gather(*(read(pr) for pr in prs)) for item in messages]
        top = max((s for s in (top, *(_parse_time(pr.get("updated_at")) for pr in prs)) if s is not None), default=None)

        handed = items[skip:skip + limit]
        mark = _iso(since)
        if skip + limit < len(items):
            return ChangePage(items=tuple(handed), next_cursor=_encode({"mark": mark, "page": page, "skip": skip + limit, "top": _iso(top)}))
        if len(prs) == SEARCH_PAGE and page * SEARCH_PAGE < int(found.get("total_count") or 0):
            return ChangePage(items=tuple(handed), next_cursor=_encode({"mark": mark, "page": page + 1, "skip": 0, "top": _iso(top)}))
        newest = max((s for s in (top, since) if s is not None), default=None)
        return ChangePage(items=tuple(handed), resume_cursor=_encode({"mark": _iso(newest)}) if newest else None)

    async def iterate(
        self, *, page_size: Optional[int] = None, narrow: Optional[Mapping[str, Any]] = None
    ) -> AsyncGenerator[MessageItem, None]:
        cursor: Optional[str] = None
        while True:
            page = await self.fetch(cursor, page_size=page_size, narrow=narrow)
            for item in page.items:
                yield item
            if (cursor := page.next_cursor) is None:
                return

    def _search(self, since: Optional[datetime]) -> str:
        terms = ["is:pr", "is:open", f"{FILTERS[self.filter]}:@me", *(f"repo:{r}" for r in self.repos)]
        if since is not None:
            terms.append(f"updated:>={since.astimezone(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ')}")
        return " ".join(terms)

    async def _messages(self, pr: dict) -> list[MessageItem]:
        """Every message of one PR, oldest first (ties by key, so a re-read lists them alike)."""
        repo = "/".join(str(pr["repository_url"]).rstrip("/").split("/")[-2:])
        n = int(pr["number"])
        key = f"{repo}#{n}"
        title = str(pr.get("title") or "") or None
        base = f"/repos/{repo}"
        out: list[MessageItem] = []

        def add(kind_id: str, sender: str, text: str, when: Any, url: Any, raw: dict, in_reply_to: Optional[str] = None) -> None:
            out.append(self._item(kind_id, key, text, sender, when, url, raw=raw, subject=title, in_reply_to=in_reply_to))

        comments, review_comments, reviews, timeline, head = await asyncio.gather(
            self._list(f"{base}/issues/{n}/comments"),
            self._list(f"{base}/pulls/{n}/comments"),
            self._list(f"{base}/pulls/{n}/reviews"),
            self._list(f"{base}/issues/{n}/timeline"),
            self._get(f"{base}/pulls/{n}"),
        )
        for c in comments:
            add(f"comment-{c['id']}", _login(c.get("user")), str(c.get("body") or ""), c.get("created_at"), c.get("html_url"), c)
        for c in review_comments:
            parent = f"review-comment-{c['in_reply_to_id']}" if c.get("in_reply_to_id") else None
            add(f"review-comment-{c['id']}", _login(c.get("user")), str(c.get("body") or ""), c.get("created_at"), c.get("html_url"), c, parent)
        for r in reviews:
            if str(r.get("state") or "").upper() == "PENDING":
                continue
            who = _login(r.get("user"))
            add(f"review-{r['id']}", who, str(r.get("body") or "") or _review_line(who, r.get("state")), r.get("submitted_at"), r.get("html_url"), r)
        for e in timeline:
            self._event(e, add, pr)

        sha = str((head.get("head") or {}).get("sha") or "")
        if sha:
            runs = (await self._get(f"{base}/commits/{sha}/check-runs", per_page=LIST_PAGE)).get("check_runs") or []
            summary = _checks_line(runs)
            if summary is not None:
                when = max((str(r.get("completed_at") or "") for r in runs), default="") or None
                add(f"check-{sha}", "", summary, when, f"{pr.get('html_url') or ''}/checks" if pr.get("html_url") else None, {"check_runs": runs})
        out.sort(key=lambda item: (item.data.sent_at or datetime.min.replace(tzinfo=timezone.utc), item.origin.key))
        return out

    def _event(self, e: dict, add, pr: dict) -> None:
        kind = str(e.get("event") or "")
        if kind not in _EVENTS:
            return
        if kind == "committed":
            sha = str(e.get("sha") or "")
            if not sha:
                return
            author = e.get("author") or {}
            who = str(author.get("name") or "")
            subject = str(e.get("message") or "").splitlines()[0] if e.get("message") else ""
            line = f"{who or 'someone'} pushed 1 commit" + (f": {subject}" if subject else "")
            add(f"commit-{sha}", who, line, author.get("date") or (e.get("committer") or {}).get("date"), e.get("html_url"), e)
            return
        if not e.get("id"):
            return
        who = _login(e.get("actor"))
        if kind == "assigned":
            assignee = _login(e.get("assignee"))
            line = f"{who} assigned {'you' if assignee and assignee == self.binding.account_key else assignee}"
        elif kind == "head_ref_force_pushed":
            line = f"{who} force-pushed"
        else:
            line = kind
        add(f"event-{e['id']}", who, line, e.get("created_at"), pr.get("html_url"), e)

    def _profile(self, login: str) -> UserProfile:
        return UserProfile(origin=self.origin(login), name=login)

    # ── setup ───────────────────────────────────────────────────────────────
    async def verify(self) -> Verdict:
        if self.credentials.token is None:
            return Verdict(ready=False, detail=SIGN_IN)
        try:
            response = await self._request("GET", "/user")
        except AccessDenied:
            return Verdict(ready=False, detail=SIGN_IN)
        header = response.headers.get("X-OAuth-Scopes")
        if header is not None:
            held = {s.strip() for s in header.split(",") if s.strip()}
            missing = [s for s in REQUIRED_SCOPES if s not in held and not (s == "read:org" and "admin:org" in held)]
            if missing:
                return Verdict(ready=False, detail=f"The GitHub sign-in lacks the `{'`, `'.join(missing)}` scope — reconnect GitHub and grant it.")
        login = _login(response.json())
        try:
            await self._get("/search/issues", q=self._search(None), per_page=1)
        except SourceError as exc:
            return Verdict(ready=False, detail=f"GitHub refused the pull-request search: {exc}")
        who = "you" if not login else f"@{login}"
        return Verdict(ready=True, detail=f"Reading open pull requests {'assigned to' if self.filter == 'assigned' else 'awaiting a review from'} {who}.")

    async def whoami(self) -> tuple[UserProfile, ...]:
        login = _login(await self._get("/user"))
        return (UserProfile(origin=CloudOrigin(kind=self.provider, namespace="github", key=login), name=login),) if login else ()

    # ── send ────────────────────────────────────────────────────────────────
    async def send(self, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, reply=False)
        if data.conversation is None:
            raise Unsupported("a GitHub PR comment goes to a pull request, not to a person")
        pr = self._pr_of(data.conversation)
        repo, n = _split(pr)
        body = await self._post(f"/repos/{repo}/issues/{n}/comments", {"body": data.text})
        return self._sent(f"comment-{body.get('id')}", pr, data.text, body)

    async def reply(self, origin: CloudOrigin, data: MessageData) -> MessageItem:
        self._require_open()
        _check_outgoing(data, reply=True)
        pr, key = self._message_of(origin)
        repo, n = _split(pr)
        if key.startswith("review-comment-"):
            path, prefix = f"/repos/{repo}/pulls/{n}/comments/{key[len('review-comment-'):]}/replies", "review-comment"
        else:
            path, prefix = f"/repos/{repo}/issues/{n}/comments", "comment"
        body = await self._post(path, {"body": data.text}, origin=origin)
        sent = self._sent(f"{prefix}-{body.get('id')}", pr, data.text, body)
        return MessageItem(origin=sent.origin, data=sent.data.model_copy(update={"in_reply_to": origin}))

    def _sent(self, key: str, pr: str, text: Optional[str], body: dict) -> MessageItem:
        """What GitHub confirmed, keyed exactly as ``fetch`` keys that comment — the echo is the same row."""
        return self._item(key, pr, text, _login(body.get("user")), body.get("created_at"), body.get("html_url"))

    def _item(
        self, key: str, pr: str, text: Optional[str], sender: str, when: Any, url: Any, *,
        raw: Optional[dict] = None, subject: Optional[str] = None, in_reply_to: Optional[str] = None,
    ) -> MessageItem:
        """One message of PR ``pr``, keyed ``key`` — the one shape ``fetch`` and a send's echo share."""
        data = GithubPrMessageData(
            text=text,
            conversation=self.conversation_origin(pr),
            subject=subject,
            sender=self._profile(sender) if sender else None,
            sent_at=_parse_time(when),
            in_reply_to=self.origin(in_reply_to, pr) if in_reply_to else None,
            raw=raw,
        )
        origin = self.origin(key, pr)
        return MessageItem(origin=origin.model_copy(update={"url": str(url)}) if url else origin, data=data)

    # ── addressing ──────────────────────────────────────────────────────────
    def _check_scope(self, origin: object) -> CloudOrigin:
        if not isinstance(origin, CloudOrigin):
            raise TypeError(f"expected CloudOrigin, got {type(origin).__name__}")
        if origin.kind != self._scope.kind:
            raise ValueError(f"{origin!r} is outside this source's scope")
        return origin

    def _pr_of(self, conversation: object) -> str:
        origin = self._check_scope(conversation)
        if origin.namespace != self.binding.account_key or not _PR.match(origin.key):
            raise NotFound(f"{origin!r} names no pull request", origin=origin)
        return origin.key

    def _message_of(self, origin: object) -> tuple[str, str]:
        """``(<owner>/<repo>#<n>, message key)`` a message origin names."""
        origin = self._check_scope(origin)
        account = self.binding.account_key
        prefix = f"{account}/" if account else ""
        pr = origin.namespace[len(prefix):] if origin.namespace.startswith(prefix) else ""
        if not _PR.match(pr) or not _MESSAGE.match(origin.key):
            raise NotFound(f"{origin!r} names no pull-request message", origin=origin)
        return pr, origin.key

    # ── transport ───────────────────────────────────────────────────────────
    def _headers(self) -> dict:
        if self.credentials.token is None:
            raise AccessDenied(f"{SIGN_IN}. Connect GitHub, then verify the source.")
        return {
            "Authorization": f"Bearer {self.credentials.token.get_secret_value()}",
            "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
        }

    async def _request(self, method: str, path: str, *, origin: Optional[CloudOrigin] = None, **kwargs: Any):
        """One call; GitHub's two 403s become the contract's errors, every other status the shared table's."""
        headers = self._headers()
        if self._client is None:
            async with http.client() as client:
                return await self._send(client, method, path, headers, origin, kwargs)
        return await self._send(self._client, method, path, headers, origin, kwargs)

    async def _send(self, client, method: str, path: str, headers: dict, origin, kwargs: dict):
        response = await http.request(
            client, method, f"{self.base_url}{path}", headers=headers, ok_statuses=(403,), origin=origin,
            hint="check the GitHub connection and the repositories", **kwargs,
        )
        if response.status_code == 403:
            if response.headers.get("X-RateLimit-Remaining") == "0" or response.headers.get("Retry-After"):
                raise SourceUnavailable("GitHub's rate limit is spent; the next pass tries again", origin=origin)
            raise AccessDenied("GitHub refused the request (HTTP 403) — check the connection's access to the repository", origin=origin)
        return response

    async def _get(self, path: str, **params: Any) -> Any:
        response = await self._request("GET", path, params=params)
        try:
            return response.json()
        except ValueError as exc:
            raise SourceUnavailable(f"GET {path}: undecodable JSON: {exc}") from exc

    async def _list(self, path: str) -> list[dict]:
        body = await self._get(path, per_page=LIST_PAGE)
        return [entry for entry in body if isinstance(entry, dict)] if isinstance(body, list) else []

    async def _post(self, path: str, payload: dict, *, origin: Optional[CloudOrigin] = None) -> dict:
        response = await self._request("POST", path, json=payload, origin=origin)
        body = response.json()
        if not isinstance(body, dict) or not body.get("id"):
            raise SourceUnavailable(f"POST {path}: GitHub confirmed no comment id")
        return body


# ── helpers ──────────────────────────────────────────────────────────────────


def _check_outgoing(data: object, *, reply: bool) -> None:
    """The shared rules (no files, provider-assigned fields empty, routing), plus GitHub's own: a
    comment is never blank — the shared check lets whitespace-only text through."""
    check_outgoing(data, reply=reply)
    if not (data.text or "").strip():
        raise ValueError("a GitHub comment needs text")


def _split(pr: str) -> tuple[str, int]:
    repo, _, n = pr.partition("#")
    return repo, int(n)


def _login(user: Any) -> str:
    return str(user.get("login") or "") if isinstance(user, dict) else ""


def _review_line(who: str, state: Any) -> str:
    verb = {"APPROVED": "approved", "CHANGES_REQUESTED": "requested changes", "DISMISSED": "had a review dismissed"}.get(str(state or "").upper(), "reviewed")
    return f"{who or 'someone'} {verb}"


def _checks_line(runs: list) -> Optional[str]:
    """``CI passed · 3 checks`` once every run finished; ``None`` while any still runs."""
    runs = [r for r in runs if isinstance(r, dict)]
    if not runs or any(str(r.get("status") or "") != "completed" for r in runs):
        return None
    failed = sum(1 for r in runs if str(r.get("conclusion") or "") not in _GREEN)
    plural = "check" if len(runs) == 1 else "checks"
    return f"CI passed · {len(runs)} {plural}" if not failed else f"CI failed · {failed} of {len(runs)} {plural}"


def _parse_time(value: Any) -> Optional[datetime]:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _stamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    parsed = _parse_time(str(value))
    if parsed is None:
        raise InvalidCursor("malformed GitHub cursor")
    return parsed


def _encode(state: dict) -> str:
    return base64.urlsafe_b64encode(json.dumps(state, sort_keys=True).encode()).decode()


def _decode(cursor: object) -> dict:
    if not isinstance(cursor, str):
        raise TypeError(f"cursor must be a string, got {type(cursor).__name__}")
    if len(cursor) > MAX_CURSOR_LENGTH:
        raise InvalidCursor("cursor is too long")
    try:
        state = json.loads(base64.urlsafe_b64decode(cursor.encode()))
    except (ValueError, TypeError, RecursionError, binascii.Error) as exc:
        raise InvalidCursor("malformed GitHub cursor") from exc
    if not isinstance(state, dict) or "mark" not in state:
        raise InvalidCursor("malformed GitHub cursor")
    if "page" in state and not (isinstance(state["page"], int) and state["page"] >= 1 and isinstance(state.get("skip", 0), int)):
        raise InvalidCursor("malformed GitHub cursor")
    return state


__all__ = ["GITHUB_API_BASE", "GithubPrMessageData", "GithubPrSource"]
