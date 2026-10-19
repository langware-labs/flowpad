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

**A PR leaves the list three ways — merged, closed, or you are no longer on it.** The timeline's
``merged`` / ``closed`` / ``unassigned``-you events end the conversation (``ends_conversation``);
``reopened`` is an ordinary message, which reopens it. A PR that leaves between two passes no longer
matches the search at all, so the cursor keeps the open PR keys it saw (``seen``, capped); at the end
of a pass a seen key the open search no longer lists is read once and its end message handed out,
keyed as its timeline event (else ``ended-<owner>/<repo>#<n>-<state>``).

**Acting:** approve, request changes, merge and close a PR from its conversation.

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

from flow_sdk.schema.data_spec.channel_spec import ActionSpec
from flow_sdk.sources import http
from flow_sdk.sources.base import positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import ChoiceEntry, SourceConfig
from flow_sdk.sources.errors import (
    AccessDenied,
    InvalidCursor,
    NotFound,
    Rejected,
    SourceError,
    SourceUnavailable,
    Unsupported,
)
from flow_sdk.sources.families import MessageSource
from flow_sdk.sources.memory import check_outgoing
from flow_sdk.sources.protocols import Verdict
from flow_sdk.sources.values.items import MessageData, MessageItem, MessageMarkSpec, UserProfile
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import MessageQuery

GITHUB_API_BASE = "https://api.github.com"
#: PRs per search page; the per-PR list page size, and how many pages of one list are read at most.
SEARCH_PAGE = 30
LIST_PAGE = 100
MAX_LIST_PAGES = 20
#: A ``closed`` event this close to a ``merged`` one is the same merge.
MERGE_CLOSE_SECONDS = 10
#: Lines of a review comment's diff hunk shown above it.
HUNK_LINES = 3
#: The scopes the connection must carry; ``X-OAuth-Scopes`` names what a classic token holds.
REQUIRED_SCOPES = ("repo", "read:org")
MAX_CURSOR_LENGTH = 4096
#: Open PR keys the cursor remembers between passes (fewer if they would overflow the cursor).
SEEN_CAP = 500
#: The open-PR membership search reads this many per page, at most ``SEEN_CAP`` in all.
MEMBERSHIP_PAGE = 100
FILTERS = {"assigned": "assignee", "review_requested": "review-requested"}
#: PRs read at once in one search page.
PR_CONCURRENCY = 6
SIGN_IN = "GitHub sign-in is missing or expired"

_PR = re.compile(r"^[^/#\s]+/[^/#\s]+#\d+$")
_MESSAGE = re.compile(r"^(comment|review-comment|review|event|commit|check)-[\w.-]+$")
#: What a review or an ending DID, drawn as a chip before its line; a commenting review has none.
_MARKS = {
    "APPROVED": MessageMarkSpec(key="approved", label="Approved", tone="positive"),
    "CHANGES_REQUESTED": MessageMarkSpec(key="changes_requested", label="Changes requested", tone="negative"),
    "DISMISSED": MessageMarkSpec(key="dismissed", label="Dismissed", tone="neutral"),
    "merged": MessageMarkSpec(key="merged", label="Merged", tone="positive"),
    "closed": MessageMarkSpec(key="closed", label="Closed", tone="neutral"),
}


def _review_mark(state: Any) -> Optional[MessageMarkSpec]:
    return _MARKS.get(str(state or "").upper())


#: Timeline events that are messages; the rest (labels, mentions, renames) are bookkeeping.
_EVENTS = frozenset({"assigned", "unassigned", "committed", "head_ref_force_pushed", "merged", "closed", "reopened"})
#: What a PR's state says when it left the search without a timeline event to show for it.
OWN_PR = "GitHub does not let you review your own pull request"


class OwnPullRequest(Rejected):
    """Approve or request changes on a PR you opened — GitHub's 422."""


class MergeBlocked(Rejected):
    """GitHub will not merge the PR as it stands (405 not mergeable, 409 head moved)."""
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
    #: A ``before`` narrow reads one page of the newest messages older than it (``_older``).
    pages_backward = True
    #: The account is the GitHub login (``account_key``), not a config field; each PR is its own
    #: conversation within it, so a reply is addressed to the PR, never to a person.
    identity_config_key = ""
    #: A normal pass hands out a whole search page of PRs at once.
    page_size = MAX_PAGE_SIZE
    #: A reply lands in the PR (or the review thread); it never quotes.
    quotes = False
    actions: ClassVar[tuple[ActionSpec, ...]] = (
        ActionSpec(id="approve", label="Approve", icon_name="CheckCircle", done_mark="approved"),
        ActionSpec(id="request_changes", label="Request changes", icon_name="CircleAlert", needs_text=True, done_mark="changes_requested"),
        ActionSpec(id="merge", label="Merge", icon_name="GitMerge", confirm="Merge this pull request into its base?", destructive=True),
        ActionSpec(id="close", label="Close", icon_name="Archive", confirm="Close this pull request?", destructive=True),
    )

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
        if query is not None and query.before is not None:
            return ChangePage(items=await self._older(query.before, limit))
        state: dict = {"page": 1, "skip": 0}
        if cursor is None:
            since = query.since if query is not None else None
        else:
            state = {"page": 1, "skip": 0, **_decode(cursor)}
            since = _stamp(state.get("mark"))

        found = await self._get("/search/issues", q=self._search(since), sort="updated", order="asc", per_page=SEARCH_PAGE, page=state["page"])
        prs = _prs(found)
        items = await self._gather_messages(prs, since)
        top = max((s for s in (_stamp(state.get("top")), *(_parse_time(pr.get("updated_at")) for pr in prs)) if s is not None), default=None)

        # A pass starting from a resume cursor first ends the PRs that left the search since.
        open_now: Optional[list[str]] = None
        ended: list[MessageItem] = []
        if state.get("seen"):
            open_now = await self._open_keys(found if since is None else None)
            gone = [key for key in state["seen"] if key not in open_now]
            ended = await _bounded_flat(self._ended(key) for key in gone)

        skip, limit_end = state["skip"], state["skip"] + limit
        handed = tuple(items[skip:limit_end]) + tuple(ended)
        onward = {"mark": _iso(since), "top": _iso(top)}
        if limit_end < len(items):
            return ChangePage(items=handed, next_cursor=_encode({**onward, "page": state["page"], "skip": limit_end}))
        if len(prs) == SEARCH_PAGE and state["page"] * SEARCH_PAGE < int(found.get("total_count") or 0):
            return ChangePage(items=handed, next_cursor=_encode({**onward, "page": state["page"] + 1, "skip": 0}))
        if open_now is None:  # a pass past its first page re-reads the open set at its end
            open_now = await self._open_keys(found if since is None and state["page"] == 1 else None)
        newest = max((s for s in (top, since) if s is not None), default=None)
        return ChangePage(items=handed, resume_cursor=_fit(_iso(newest), open_now))

    async def _older(self, before: datetime, limit: int) -> list[MessageItem]:
        """The ``limit`` newest messages sent strictly before ``before``, newest first — one backward
        page; the forward cursor is neither read nor moved. The search lists the PRs most recently
        updated that were CREATED before the bound (a PR created after it holds nothing older, while
        one updated after it still can), newest update first, ``limit`` of them."""
        stamp = _gh_stamp(before)
        found = await self._get("/search/issues", q=f"{self._search(None)} created:<{stamp}", sort="updated", order="desc", per_page=min(limit, SEARCH_PAGE))
        everything = await self._gather_messages(_prs(found))
        older = [item for item in everything if item.data.sent_at is not None and item.data.sent_at < before]
        older.sort(key=lambda item: (item.data.sent_at, item.origin.key), reverse=True)
        return older[:limit]

    async def _gather_messages(self, prs: list[dict], since: Optional[datetime] = None) -> list[MessageItem]:
        """Every message of ``prs``, PR by PR in order, read at most ``PR_CONCURRENCY`` at a time."""
        return await _bounded_flat(self._messages(pr, since) for pr in prs)

    async def _open_keys(self, found: Optional[dict] = None) -> list[str]:
        """Every open PR the search lists now, as ``<owner>/<repo>#<n>``, oldest update first.
        ``found`` — this pass's own unnarrowed first search page — is reused when it held them all."""
        if found is not None and int(found.get("total_count") or 0) <= SEARCH_PAGE:
            rows = _prs(found)
        else:
            rows = [pr async for pr in http.paginate(
                self._client, f"{self.base_url}/search/issues", key="items", max_pages=SEEN_CAP // MEMBERSHIP_PAGE, **self._wire(),
                params={"q": self._search(None), "sort": "updated", "order": "asc", "per_page": MEMBERSHIP_PAGE},
            ) if isinstance(pr, dict) and pr.get("number") and pr.get("repository_url")]
        return [f"{_repo_of(pr)}#{int(pr['number'])}" for pr in rows]

    async def _ended(self, key: str) -> list[MessageItem]:
        """The end message of PR ``key``, which left the search since the last pass: its timeline's
        last ending event, keyed as a read keys it, else one ``ended-<key>-<state>`` line."""
        if not _PR.match(key):
            return []
        repo, n = _split(key)
        try:
            head, timeline = await asyncio.gather(self._get(f"/repos/{repo}/pulls/{n}"), self._list(f"/repos/{repo}/issues/{n}/timeline"))
        except NotFound:
            return []
        title = str(head.get("title") or "") or None
        found: list[MessageItem] = []
        add = self._adder(found, key, title)
        self._events(timeline, add, head, head)
        ending = [item for item in found if item.data.ends_conversation]
        if ending:
            return [max(ending, key=lambda item: item.data.sent_at or datetime.min.replace(tzinfo=timezone.utc))]
        state = "merged" if head.get("merged") or head.get("merged_at") else str(head.get("state") or "open")
        line = {"merged": "merged", "closed": "closed", "open": "You are no longer on this pull request"}.get(state, state)
        when = head.get("merged_at") or head.get("closed_at") or head.get("updated_at")
        return [self._item(f"ended-{key}-{state}", key, line, "", when, head.get("html_url"), raw=head, subject=title, ends=True, mark=_MARKS.get(state))]

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
            terms.append(f"updated:>={_gh_stamp(since)}")
        return " ".join(terms)

    async def _messages(self, pr: dict, since: Optional[datetime] = None) -> list[MessageItem]:
        """Every message of one PR, oldest first (ties by key, so a re-read lists them alike).
        ``since`` narrows the two comment lists that take it; the rest are read whole."""
        repo = _repo_of(pr)
        n = int(pr["number"])
        key = f"{repo}#{n}"
        title = str(pr.get("title") or "") or None
        base = f"/repos/{repo}"
        out: list[MessageItem] = []

        add = self._adder(out, key, title)

        comments, review_comments, reviews, timeline, head = await asyncio.gather(
            self._list(f"{base}/issues/{n}/comments", since=since),
            self._list(f"{base}/pulls/{n}/comments", since=since),
            self._list(f"{base}/pulls/{n}/reviews"),
            self._list(f"{base}/issues/{n}/timeline"),
            self._get(f"{base}/pulls/{n}"),
        )
        for c in comments:
            add(f"comment-{c['id']}", _login(c.get("user")), str(c.get("body") or ""), c.get("created_at"), c.get("html_url"), c)
        for c in review_comments:
            parent = f"review-comment-{c['in_reply_to_id']}" if c.get("in_reply_to_id") else None
            text = str(c.get("body") or "") if parent else _line_comment(c)
            add(f"review-comment-{c['id']}", _login(c.get("user")), text, c.get("created_at"), c.get("html_url"), c, parent)
        for r in reviews:
            state = str(r.get("state") or "").upper()
            # PENDING is a draft; an empty COMMENTED review is only the wrapper of line comments.
            if state == "PENDING" or (state == "COMMENTED" and not str(r.get("body") or "").strip()):
                continue
            who = _login(r.get("user"))
            add(f"review-{r['id']}", who, str(r.get("body") or "") or _review_line(who, r.get("state")), r.get("submitted_at"), r.get("html_url"), r, mark=_review_mark(state))
        self._events(timeline, add, pr, head)

        sha = str((head.get("head") or {}).get("sha") or "")
        if sha:
            runs = await self._list(f"{base}/commits/{sha}/check-runs", key="check_runs")
            summary = _checks_line(runs)
            if summary is not None:
                when = max((str(r.get("completed_at") or "") for r in runs), default="") or None
                app = next((str((r.get("app") or {}).get("name") or "") for r in runs if isinstance(r, dict) and (r.get("app") or {}).get("name")), "")
                add(f"check-{sha}", app or "CI", summary, when, f"{pr.get('html_url') or ''}/checks" if pr.get("html_url") else None, {"check_runs": runs})
        out.sort(key=lambda item: (item.data.sent_at or datetime.min.replace(tzinfo=timezone.utc), item.origin.key))
        return out

    def _adder(self, out: list[MessageItem], key: str, title: Optional[str]):
        """``add(kind_id, sender, text, when, url, raw, in_reply_to=None, *, ends=False, mark=None)``
        appending one message of PR ``key`` to ``out``."""

        def add(
            kind_id: str, sender: str, text: str, when: Any, url: Any, raw: dict, in_reply_to: Optional[str] = None, *,
            ends: bool = False, mark: Optional[MessageMarkSpec] = None,
        ) -> None:
            out.append(self._item(kind_id, key, text, sender, when, url, raw=raw, subject=title, in_reply_to=in_reply_to, ends=ends, mark=mark))

        return add

    def _ends(self, e: dict) -> bool:
        """Timeline event ``e`` ends the conversation: merged, closed, or it took you off the PR."""
        kind = str(e.get("event") or "")
        return bool(e.get("id")) and (kind in ("merged", "closed") or (kind == "unassigned" and _login(e.get("assignee")) == self.binding.account_key))

    def _events(self, timeline: list[dict], add, pr: dict, head: Optional[dict] = None) -> None:
        """Each timeline event that is a message, through ``add``; labels, mentions, renames and
        someone else's unassignment are bookkeeping.

        GitHub records a merge as a ``merged`` AND a ``closed`` event, either of which may reach the
        timeline first. The merge is the ``closed`` event, said "merged by X": it is beside a
        ``merged`` event, or it is the last close of a PR (``head``) that says it merged. The
        ``merged`` event itself is never a message, so a late one cannot add a second."""
        merges = [t for e in timeline if e.get("event") == "merged" and (t := _parse_time(e.get("created_at"))) is not None]
        closes = [e for e in timeline if e.get("event") == "closed" and e.get("id")]
        merged_pr = bool(head and (head.get("merged") or head.get("merged_at")))
        for e in timeline:
            kind = str(e.get("event") or "")
            if kind not in _EVENTS or kind == "merged" or (kind == "unassigned" and not self._ends(e)):
                continue
            if kind == "closed":
                when = _parse_time(e.get("created_at"))
                beside = when is not None and any(abs((when - m).total_seconds()) <= MERGE_CLOSE_SECONDS for m in merges)
                if beside or (merged_pr and e is closes[-1]):
                    kind = "merged"
            self._event(e, kind, add, pr)

    def _event(self, e: dict, kind: str, add, pr: dict) -> None:
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
        elif kind == "unassigned":
            line = f"{who} unassigned you"
        elif kind == "head_ref_force_pushed":
            line = f"{who} force-pushed"
        elif kind in ("closed", "merged"):
            line = f"{kind} by {who}" if who else kind
        else:
            line = kind
        add(f"event-{e['id']}", who, line, e.get("created_at"), pr.get("html_url"), e, ends=self._ends(e), mark=_MARKS.get(kind))

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

    # ── acting ──────────────────────────────────────────────────────────────
    async def act(self, conversation: CloudOrigin, action: str, text: str = "") -> Optional[MessageItem]:
        """Do ``action`` to the PR ``conversation`` names. A review comes back keyed ``review-<id>`` as
        a read keys it; a merge or close has no event id in GitHub's answer, so it returns ``None`` and
        the next pass brings the timeline's ``merged`` / ``closed`` event."""
        self._require_open()
        pr = self._pr_of(conversation)
        repo, n = _split(pr)
        if action == "request_changes" and not (text or "").strip():
            raise ValueError("requesting changes needs a comment saying what to change")
        call = {
            "approve": ("POST", "/reviews", {"event": "APPROVE"}),
            "request_changes": ("POST", "/reviews", {"event": "REQUEST_CHANGES", "body": text}),
            "merge": ("PUT", "/merge", {}),
            "close": ("PATCH", "", {"state": "closed"}),
        }.get(action)
        if call is None:
            raise Unsupported(f"a GitHub pull request has no action {action!r}")
        method, suffix, payload = call
        body = await self._act(method, f"/repos/{repo}/pulls/{n}{suffix}", payload, conversation)
        if suffix != "/reviews" or not isinstance(body, dict) or not body.get("id"):
            return None
        who = _login(body.get("user"))
        return self._item(f"review-{body['id']}", pr, str(body.get("body") or "") or _review_line(who, body.get("state")), who, body.get("submitted_at"), body.get("html_url"), raw=body, mark=_review_mark(body.get("state")))

    async def _act(self, method: str, path: str, payload: dict, origin: CloudOrigin) -> Any:
        response = await self._request(method, path, json=payload, origin=origin, ok_statuses=(405, 409, 422))
        try:
            body = response.json()
        except ValueError:
            body = {}
        if response.status_code < 400:
            return body
        said = str(body.get("message") or "") if isinstance(body, dict) else ""
        errors = " ".join(str(e.get("message") if isinstance(e, dict) else e) for e in (body.get("errors") or ())) if isinstance(body, dict) else ""
        if response.status_code == 422 and "own pull request" in f"{said} {errors}".lower():
            raise OwnPullRequest(OWN_PR, origin=origin)
        if response.status_code in (405, 409):
            raise MergeBlocked(f"GitHub cannot merge this pull request: {said or 'it is not mergeable'}", origin=origin)
        raise Rejected(f"GitHub refused: {' — '.join(p for p in (said, errors) if p) or f'HTTP {response.status_code}'}", origin=origin)

    def _sent(self, key: str, pr: str, text: Optional[str], body: dict) -> MessageItem:
        """What GitHub confirmed, keyed exactly as ``fetch`` keys that comment — the echo is the same row."""
        return self._item(key, pr, text, _login(body.get("user")), body.get("created_at"), body.get("html_url"))

    def _item(
        self, key: str, pr: str, text: Optional[str], sender: str, when: Any, url: Any, *,
        raw: Optional[dict] = None, subject: Optional[str] = None, in_reply_to: Optional[str] = None, ends: bool = False,
        mark: Optional[MessageMarkSpec] = None,
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
            ends_conversation=ends,
            mark=mark,
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
        """The PR (``<owner>/<repo>#<n>``) a conversation origin names: its own ``(account, PR)``, or
        the shape the surface acts with — a message's namespace (``<account>/<PR>``) with the PR as key."""
        origin = self._check_scope(conversation)
        account = self.binding.account_key
        if _PR.match(origin.key) and (origin.namespace == account or origin.namespace.startswith(f"{account}/")):
            return origin.key
        raise NotFound(f"{origin!r} names no pull request", origin=origin)

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

    async def _request(self, method: str, path: str, *, origin: Optional[CloudOrigin] = None, ok_statuses: tuple[int, ...] = (), **kwargs: Any):
        """One call; a status is the shared table's error (a rate-limited 403 is a wait, not a refusal)."""
        if self._client is None:
            async with http.client() as client:
                return await http.request(client, method, f"{self.base_url}{path}", ok_statuses=ok_statuses, **self._wire(origin), **kwargs)
        return await http.request(self._client, method, f"{self.base_url}{path}", ok_statuses=ok_statuses, **self._wire(origin), **kwargs)

    def _wire(self, origin: Optional[CloudOrigin] = None) -> dict:
        """What every GitHub call carries: the token, the hint, the origin an error names."""
        return {"headers": self._headers(), "hint": "check the GitHub connection and the repositories", "origin": origin}

    async def _get(self, path: str, **params: Any) -> Any:
        response = await self._request("GET", path, params=params)
        try:
            return response.json()
        except ValueError as exc:
            raise SourceUnavailable(f"GET {path}: undecodable JSON: {exc}") from exc

    async def _list(self, path: str, *, key: Optional[str] = None, since: Optional[datetime] = None) -> list[dict]:
        """Every entry of a GitHub list across its ``Link: rel="next"`` pages (``key`` when the list
        rides in an object, as check runs do); ``since`` on the lists that take it."""
        params: dict = {"per_page": LIST_PAGE}
        if since is not None:
            params["since"] = _gh_stamp(since)
        return [entry async for entry in http.paginate(
            self._client, f"{self.base_url}{path}", params=params, key=key, max_pages=MAX_LIST_PAGES, **self._wire(),
        ) if isinstance(entry, dict)]

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


def _repo_of(pr: dict) -> str:
    return "/".join(str(pr["repository_url"]).rstrip("/").split("/")[-2:])


def _fit(mark: Optional[str], seen: list[str]) -> Optional[str]:
    """The resume cursor: ``mark`` and the newest ``seen`` keys that fit (at most ``SEEN_CAP``, the
    cursor within ``MAX_CURSOR_LENGTH``); ``None`` when there is nothing to carry."""
    budget = MAX_CURSOR_LENGTH * 3 // 4 - len(json.dumps({"mark": mark, "seen": []}, sort_keys=True))
    keep: list[str] = []
    for key in reversed(seen[-SEEN_CAP:]):
        budget -= len(json.dumps(key)) + 2
        if budget < 0:
            break
        keep.append(key)
    if mark is None and not keep:
        return None
    return _encode({"mark": mark, "seen": keep[::-1]} if keep else {"mark": mark})


def _prs(found: dict) -> list[dict]:
    """The PRs of one search answer."""
    return [pr for pr in found.get("items") or () if isinstance(pr, dict) and pr.get("number") and pr.get("repository_url")]


def _split(pr: str) -> tuple[str, int]:
    repo, _, n = pr.partition("#")
    return repo, int(n)


def _login(user: Any) -> str:
    return str(user.get("login") or "") if isinstance(user, dict) else ""


def _line_comment(c: dict) -> str:
    """A review comment's text, led by where it is: ``path:line`` and the last lines of its hunk,
    each behind a ``│ `` gutter.
    ``MessageData`` has no quote field, so the place rides in the text."""
    body = str(c.get("body") or "")
    path = str(c.get("path") or "")
    if not path:
        return body
    line = c.get("line") or c.get("original_line")
    tail = [h for h in str(c.get("diff_hunk") or "").splitlines() if not h.startswith("@@")][-HUNK_LINES:]
    # The bubble renders plain text (pre-wrap), not block markdown: a fence would show its backticks.
    snippet = "".join(f"\n│ {h}" for h in tail)
    return f"{path}{f':{line}' if line else ''}{snippet}\n{body}"


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


def _gh_stamp(value: datetime) -> str:
    """``value`` as GitHub's search/``since`` timestamp: UTC, whole seconds, ``Z``."""
    return value.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


async def _bounded_flat(works) -> list:
    """Run the awaitables at most ``PR_CONCURRENCY`` at a time; their lists, flattened in order."""
    gate = asyncio.Semaphore(PR_CONCURRENCY)

    async def gated(work):
        async with gate:
            return await work

    return [item for found in await asyncio.gather(*(gated(work) for work in works)) for item in found]


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
    if not isinstance(state.get("seen", []), list) or not all(isinstance(k, str) for k in state.get("seen", [])):
        raise InvalidCursor("malformed GitHub cursor")
    if "page" in state and not (isinstance(state["page"], int) and state["page"] >= 1 and isinstance(state.get("skip", 0), int)):
        raise InvalidCursor("malformed GitHub cursor")
    return state


__all__ = ["GITHUB_API_BASE", "GithubPrMessageData", "GithubPrSource"]
