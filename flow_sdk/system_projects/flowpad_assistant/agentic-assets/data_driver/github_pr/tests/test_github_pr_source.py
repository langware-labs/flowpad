"""The ``github_pr`` data source, against a real socket serving GitHub's own response shapes.

What these pin: a PR is ONE conversation whatever kind of thing happened on it; a pass pages across
search pages AND within one (a PR is many messages); the resume cursor narrows the search to
``updated:>=``; a reply is keyed exactly as the next read keys that comment, so the echo is the same
row; and GitHub's 403 is either a rate limit (wait) or a refusal.
"""
from __future__ import annotations

import json
import time
from datetime import datetime, timezone
from types import SimpleNamespace
from urllib.parse import parse_qs, unquote_plus

import pytest
from pydantic import SecretStr

from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.testing import local_http_server
from flow_sdk.sources import UserProfile
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.errors import AccessDenied, SourceUnavailable
from flow_sdk.sources.testing import Subject, checks_for
from flow_sdk.sources.values.items import MessageData

GithubPrSource = asset_module("github_pr").GithubPrSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ME = "serans1"
PR = "octo/app#7"


def _iso(seconds: float) -> str:
    return datetime.fromtimestamp(seconds, tz=timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


class _FakeGithub:
    """Open PRs with their comments, review comments, reviews, timeline and check runs; posts land as
    new comments. ``fail`` answers every call with ``(status, headers)`` while set; ``scopes`` is the
    ``X-OAuth-Scopes`` ``/user`` answers (``None`` omits the header)."""

    me = ME

    def __init__(self):
        self.clock = 1_790_000_000.0
        self.next_id = 1000
        self.prs: dict[str, dict] = {}
        self.posts: list[dict] = []
        self.calls: list[tuple[str, str]] = []
        self.fail: tuple[int, dict] | None = None
        self.scopes: str | None = "repo, read:org"

    def tick(self) -> str:
        """A second later than any stamp so far and never behind the wall clock."""
        self.clock = max(float(int(time.time())), self.clock + 1)
        return _iso(self.clock)

    def ident(self) -> int:
        self.next_id += 1
        return self.next_id

    def pr(self, key: str, title: str = "Fix the thing", assignee: str = ME) -> dict:
        repo, n = key.split("#")
        entry = self.prs.setdefault(key, {
            "repo": repo, "number": int(n), "title": title, "assignee": assignee, "updated_at": self.tick(),
            "sha": f"sha{n}", "comments": [], "review_comments": [], "reviews": [], "timeline": [], "checks": [],
        })
        return entry

    def comment(self, key: str, body: str, *, user: str) -> dict:
        pr = self.pr(key)
        c = {"id": self.ident(), "user": {"login": user}, "body": body, "created_at": self.tick(),
             "html_url": f"https://github.com/{pr['repo']}/pull/{pr['number']}#issuecomment-{self.next_id}"}
        pr["comments"].append(c)
        pr["updated_at"] = c["created_at"]
        return c

    def review_comment(self, key: str, body: str, *, user: str, in_reply_to: int | None = None) -> dict:
        pr = self.pr(key)
        c = {"id": self.ident(), "user": {"login": user}, "body": body, "created_at": self.tick(),
             "html_url": f"https://github.com/{pr['repo']}/pull/{pr['number']}#discussion_r{self.next_id}"}
        if in_reply_to:
            c["in_reply_to_id"] = in_reply_to
        pr["review_comments"].append(c)
        pr["updated_at"] = c["created_at"]
        return c

    def __call__(self, path, headers):
        route, _, query = path.partition("?")
        params = {k: v[0] for k, v in parse_qs(query).items()}
        method = str(headers.get("_method") or "GET")
        self.calls.append((method, unquote_plus(path)))
        if self.fail is not None:
            status, extra = self.fail
            return status, json.dumps({"message": "nope"}).encode(), {"Content-Type": "application/json", **extra}
        if route == "/user":
            extra = {"X-OAuth-Scopes": self.scopes} if self.scopes is not None else {}
            return self._json({"login": self.me}, **extra)
        if route == "/search/issues":
            return self._search(params)
        parts = route.strip("/").split("/")  # repos/<owner>/<repo>/<kind>/<n>/...
        if len(parts) < 5 or parts[0] != "repos":
            return 404, b"{}", {}
        key = f"{parts[1]}/{parts[2]}#{parts[4]}" if parts[3] in ("issues", "pulls") else ""
        pr = self.prs.get(key)
        if parts[3] == "commits":
            pr = next((p for p in self.prs.values() if p["sha"] == parts[4]), None)
            return self._json({"total_count": len(pr["checks"]) if pr else 0, "check_runs": pr["checks"] if pr else []})
        if pr is None:
            return 404, json.dumps({"message": "Not Found"}).encode(), {"Content-Type": "application/json"}
        tail = parts[5:]
        if method == "POST":
            body = json.loads(headers["_body"])["body"]
            if parts[3] == "issues" and tail == ["comments"]:
                made = self.comment(key, body, user=self.me)
            elif parts[3] == "pulls" and len(tail) == 3 and tail[0] == "comments" and tail[2] == "replies":
                if not any(str(c["id"]) == tail[1] for c in pr["review_comments"]):
                    return 404, b'{"message":"Not Found"}', {"Content-Type": "application/json"}
                made = self.review_comment(key, body, user=self.me, in_reply_to=int(tail[1]))
            else:
                return 404, b"{}", {}
            self.posts.append({"to": key, "text": body, "thread": key, "external_id": ("review-comment-" if "in_reply_to_id" in made else "comment-") + str(made["id"])})
            return self._json(made, status=201)
        if parts[3] == "pulls" and not tail:
            return self._json({"number": pr["number"], "title": pr["title"], "head": {"sha": pr["sha"]}})
        lists = {("issues", "comments"): "comments", ("pulls", "comments"): "review_comments", ("pulls", "reviews"): "reviews", ("issues", "timeline"): "timeline"}
        name = lists.get((parts[3], tail[0] if tail else ""))
        return self._json(pr[name]) if name else (404, b"{}", {})

    def _search(self, params: dict):
        terms = params.get("q", "").split()
        repos = [t[5:] for t in terms if t.startswith("repo:")]
        since = next((t[len("updated:>="):] for t in terms if t.startswith("updated:>=")), None)
        who = "review" if "review-requested:@me" in terms else "assignee"
        rows = [p for p in self.prs.values() if (not repos or p["repo"] in repos) and (since is None or p["updated_at"] >= since)
                and (who == "review" or p["assignee"] == self.me)]
        rows.sort(key=lambda p: (p["updated_at"], p["repo"], p["number"]))
        per, page = int(params.get("per_page") or 30), int(params.get("page") or 1)
        chunk = rows[(page - 1) * per: page * per]
        return self._json({"total_count": len(rows), "items": [{
            "number": p["number"], "title": p["title"], "updated_at": p["updated_at"],
            "repository_url": f"https://api.github.com/repos/{p['repo']}",
            "html_url": f"https://github.com/{p['repo']}/pull/{p['number']}",
        } for p in chunk]})

    @staticmethod
    def _json(body, status: int = 200, **headers):
        return status, json.dumps(body).encode(), {"Content-Type": "application/json", **headers}


@pytest.fixture
def github():
    fake = _FakeGithub()
    with local_http_server(fake) as base:
        yield SimpleNamespace(base=base, gh=fake)


def _source(base: str, token: str | None = "gho_test", **config) -> GithubPrSource:
    credentials = ResolvedSecrets(shape=AuthShape.CONNECTOR, token=SecretStr(token)) if token else ResolvedSecrets()
    return GithubPrSource(SourceBinding(account_key=ME, config={"base_url": base, **config}, credentials=credentials))


async def _all(source: GithubPrSource, cursor=None, page_size=None):
    items, pages = [], 0
    async with source as s:
        while True:
            page = await s.fetch(cursor, page_size=page_size)
            items.extend(page.items)
            pages += 1
            if page.next_cursor is None:
                return items, page.resume_cursor, pages
            cursor = page.next_cursor


# ── the contract ─────────────────────────────────────────────────────────────


@pytest.mark.parametrize("check", checks_for(GithubPrSource), ids=str)
async def test_conformance(check, github):
    for body in ("first", "second", "third"):
        github.gh.comment(PR, body, user="dana")
    seeded = [f"comment-{c['id']}" for c in github.gh.prs[PR]["comments"]]
    probe = _source(github.base)
    await check.run(Subject(
        source=lambda: _source(github.base),
        seeded=tuple(probe.origin(k, PR) for k in seeded),
        conversation=probe.conversation_origin(PR),
        recipient=UserProfile(origin=probe.origin("dana"), name="dana"),
    ))


# ── reading ──────────────────────────────────────────────────────────────────


async def test_comments_reviews_events_and_checks_are_one_conversation(github):
    gh = github.gh
    pr = gh.pr(PR, title="Speed up the indexer")
    gh.comment(PR, "looks good?", user="dana")
    root = gh.review_comment(PR, "nit: rename", user="dana")
    gh.review_comment(PR, "done", user=ME, in_reply_to=root["id"])
    pr["reviews"].append({"id": 55, "user": {"login": "dana"}, "state": "APPROVED", "body": "", "submitted_at": gh.tick(), "html_url": "https://github.com/r/55"})
    pr["reviews"].append({"id": 56, "user": {"login": "dana"}, "state": "PENDING", "body": "draft"})
    pr["timeline"] += [
        {"id": 71, "event": "assigned", "actor": {"login": "dana"}, "assignee": {"login": ME}, "created_at": gh.tick()},
        {"event": "committed", "sha": "abc123", "message": "Cache the walk\n\nbody", "author": {"name": ME, "date": gh.tick()}, "html_url": "https://github.com/c/abc123"},
        {"id": 72, "event": "labeled", "actor": {"login": "dana"}, "created_at": gh.tick()},
        {"id": 73, "event": "merged", "actor": {"login": "dana"}, "created_at": gh.tick()},
    ]
    pr["checks"] += [{"id": i, "status": "completed", "conclusion": "success", "completed_at": gh.tick()} for i in (1, 2, 3)]

    items, _, _ = await _all(_source(github.base))
    by_key = {i.origin.key: i for i in items}
    assert {i.data.conversation.key for i in items} == {PR}
    assert {i.data.subject for i in items} == {"Speed up the indexer"}
    assert by_key[f"review-comment-{root['id'] + 1}"].data.in_reply_to.key == f"review-comment-{root['id']}"
    texts = {k: by_key[k].data.text for k in by_key}
    assert texts["review-55"] == "dana approved"
    assert texts["event-71"] == "dana assigned you"
    assert texts["commit-abc123"] == f"{ME} pushed 1 commit: Cache the walk"
    assert texts["event-73"] == "merged"
    assert texts[f"check-{pr['sha']}"] == "CI passed · 3 checks"
    assert "review-56" not in by_key and "event-72" not in by_key, "a pending review or a label is not a message"
    assert by_key["event-71"].data.sender.name == "dana"
    assert [i.data.sent_at for i in items] == sorted(i.data.sent_at for i in items)


async def test_a_failing_check_says_how_many_and_a_running_one_says_nothing(github):
    gh = github.gh
    gh.pr("octo/app#1")["checks"] += [{"id": 1, "status": "completed", "conclusion": "failure", "completed_at": gh.tick()},
                                      {"id": 2, "status": "completed", "conclusion": "success", "completed_at": gh.tick()}]
    gh.pr("octo/app#2")["checks"] += [{"id": 3, "status": "in_progress"}]
    items, _, _ = await _all(_source(github.base))
    assert [i.data.text for i in items if i.origin.key.startswith("check-")] == ["CI failed · 1 of 2 checks"]


async def test_paging_crosses_search_pages_and_slices_within_one(github, monkeypatch):
    monkeypatch.setattr(asset_module("github_pr"), "SEARCH_PAGE", 2)
    gh = github.gh
    for n in range(1, 6):
        gh.comment(f"octo/app#{n}", f"pr {n}", user="dana")
    items, resume, pages = await _all(_source(github.base))
    assert [i.data.text for i in items] == [f"pr {n}" for n in range(1, 6)]
    assert pages == 3 and resume is not None
    sliced, _, sliced_pages = await _all(_source(github.base), page_size=1)
    assert [i.origin for i in sliced] == [i.origin for i in items] and sliced_pages == 5


async def test_the_resume_cursor_narrows_to_updated_since_the_mark(github):
    gh = github.gh
    gh.comment(PR, "old", user="dana")
    _, resume, _ = await _all(_source(github.base))
    mark = gh.prs[PR]["updated_at"]
    gh.calls.clear()
    gh.comment("octo/app#8", "new", user="dana")
    items, again, _ = await _all(_source(github.base), cursor=resume)
    search = next(p for m, p in gh.calls if p.startswith("/search/issues"))
    assert f"updated:>={mark}" in search and "assignee:@me" in search
    assert {i.data.conversation.key for i in items} == {PR, "octo/app#8"}, "the mark is inclusive: PR seen again, new PR read"
    assert again != resume


async def test_repos_and_the_review_filter_shape_the_search(github):
    gh = github.gh
    gh.comment(PR, "hi", user="dana")
    await _all(_source(github.base, repos=["octo/app", "octo/lib"], filter="review_requested"))
    search = next(p for m, p in gh.calls if p.startswith("/search/issues"))
    assert "review-requested:@me" in search and "repo:octo/app" in search and "repo:octo/lib" in search


# ── writing ──────────────────────────────────────────────────────────────────


async def test_a_reply_to_an_issue_comment_is_keyed_as_the_next_read_keys_it(github):
    c = github.gh.comment(PR, "can you look?", user="dana")
    source = _source(github.base)
    async with source as s:
        sent = await s.reply(s.origin(f"comment-{c['id']}", PR), MessageData(text="on it"))
    items, _, _ = await _all(_source(github.base))
    echo = next(i for i in items if i.data.text == "on it")
    assert sent.origin == echo.origin and sent.origin.key.startswith("comment-")
    assert sent.data.conversation == echo.data.conversation
    assert github.gh.posts[-1]["to"] == PR


async def test_a_reply_to_a_review_comment_answers_in_its_thread(github):
    root = github.gh.review_comment(PR, "why this?", user="dana")
    source = _source(github.base)
    async with source as s:
        sent = await s.reply(s.origin(f"review-comment-{root['id']}", PR), MessageData(text="because"))
    assert any(m == "POST" and p.endswith(f"/pulls/7/comments/{root['id']}/replies") for m, p in github.gh.calls)
    items, _, _ = await _all(_source(github.base))
    echo = next(i for i in items if i.data.text == "because")
    assert sent.origin == echo.origin and echo.data.in_reply_to.key == f"review-comment-{root['id']}"


def test_message_for_routes_a_reply_and_a_plain_send():
    source = GithubPrSource(SourceBinding(account_key=ME, config={}))
    data, answered = source.message_for(thread_key=PR, to=PR, text="x", in_reply_to="review-comment-9")
    assert answered == source.origin("review-comment-9", PR) and data.conversation is None
    data, answered = source.message_for(thread_key="", to=PR, text="x")
    assert answered is None and data.conversation == source.conversation_origin(PR)
    with pytest.raises(ValueError):
        source.message_for(thread_key="", to="not a pr", text="x")


# ── errors and setup ─────────────────────────────────────────────────────────


async def test_401_is_an_access_error(github):
    github.gh.fail = (401, {})
    with pytest.raises(AccessDenied):
        await _all(_source(github.base))


async def test_a_rate_limited_403_is_transient_and_a_plain_403_is_a_refusal(github):
    github.gh.fail = (403, {"X-RateLimit-Remaining": "0", "X-RateLimit-Reset": "1790000000"})
    with pytest.raises(SourceUnavailable):
        await _all(_source(github.base))
    github.gh.fail = (403, {"X-RateLimit-Remaining": "4999"})
    with pytest.raises(AccessDenied):
        await _all(_source(github.base))


async def test_a_5xx_is_transient(github):
    github.gh.fail = (502, {})
    with pytest.raises(SourceUnavailable):
        await _all(_source(github.base))


async def test_verify_names_a_missing_scope(github):
    github.gh.scopes = "read:org"
    async with _source(github.base) as s:
        verdict = await s.verify()
    assert not verdict.ready and "`repo`" in verdict.detail


async def test_verify_without_a_token_or_with_an_expired_one_asks_for_sign_in(github):
    async with _source(github.base, token=None) as s:
        assert (await s.verify()).detail == "GitHub sign-in is missing or expired"
    github.gh.fail = (401, {})
    async with _source(github.base) as s:
        verdict = await s.verify()
    assert not verdict.ready and verdict.detail == "GitHub sign-in is missing or expired"


async def test_verify_is_ready_and_whoami_is_the_login(github):
    async with _source(github.base) as s:
        assert (await s.verify()).ready
        (me,) = await s.whoami()
    assert me.name == ME
