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
        #: Entries per list page GitHub answers with (a ``Link: rel="next"`` beyond it); None = all.
        self.list_page: int | None = None

    def tick(self) -> str:
        """A second later than any stamp so far and never behind the wall clock."""
        self.clock = max(float(int(time.time())), self.clock + 1)
        return _iso(self.clock)

    def ident(self) -> int:
        self.next_id += 1
        return self.next_id

    def pr(self, key: str, title: str = "Fix the thing", assignee: str = ME) -> dict:
        repo, n = key.split("#")
        if key in self.prs:
            return self.prs[key]
        created = self.tick()
        entry = self.prs[key] = {
            "repo": repo, "number": int(n), "title": title, "assignee": assignee, "created_at": created, "updated_at": created,
            "sha": f"sha{n}", "state": "open", "merged": False, "author": "dana", "mergeable": True, "comments": [], "review_comments": [], "reviews": [], "timeline": [], "checks": [],
        }
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
        if method in ("PUT", "PATCH") or (method == "POST" and tail == ["reviews"]):
            return self._act(key, pr, method, tail, json.loads(headers["_body"] or "{}"))
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
            return self._json({"number": pr["number"], "title": pr["title"], "head": {"sha": pr["sha"]}, "state": pr["state"],
                               "merged": pr["merged"], "updated_at": pr["updated_at"], "html_url": f"https://github.com/{key.replace('#', '/pull/')}"})
        lists = {("issues", "comments"): "comments", ("pulls", "comments"): "review_comments", ("pulls", "reviews"): "reviews", ("issues", "timeline"): "timeline"}
        name = lists.get((parts[3], tail[0] if tail else ""))
        if not name:
            return 404, b"{}", {}
        rows, page = pr[name], int(params.get("page") or 1)
        if self.list_page is None:
            return self._json(rows)
        chunk = rows[(page - 1) * self.list_page: page * self.list_page]
        more = {"Link": f'<http://{headers.get("Host")}{route}?per_page={self.list_page}&page={page + 1}>; rel="next"'} if page * self.list_page < len(rows) else {}
        return self._json(chunk, **more)

    def _act(self, key: str, pr: dict, method: str, tail: list, body: dict):
        """A review, a merge (PUT .../merge) or a close (PATCH the PR)."""
        if method == "POST":
            if pr["author"] == self.me:
                verb = "approve" if body["event"] == "APPROVE" else "request changes on"
                return self._json({"message": "Unprocessable Entity", "errors": [f"Can not {verb} your own pull request"]}, status=422)
            review = {"id": self.ident(), "user": {"login": self.me}, "state": {"APPROVE": "APPROVED"}.get(body["event"], "CHANGES_REQUESTED"),
                      "body": body.get("body", ""), "submitted_at": self.tick(), "html_url": f"https://github.com/r/{self.next_id}"}
            pr["reviews"].append(review)
            pr["updated_at"] = review["submitted_at"]
            self.posts.append({"to": key, "event": body["event"]})
            return self._json(review)
        if method == "PUT" and tail == ["merge"]:
            if not pr["mergeable"]:
                return self._json({"message": "Pull Request is not mergeable"}, status=405)
            self.end(key, "merged")
            return self._json({"sha": "m1", "merged": True, "message": "Pull Request successfully merged"})
        if method == "PATCH" and not tail and body.get("state") == "closed":
            self.end(key, "closed")
            return self._json({"number": pr["number"], "state": "closed"})
        return 404, b"{}", {}

    def end(self, key: str, how: str, *, event: bool = True) -> None:
        """PR ``key`` merged or closed (with its timeline events unless ``event`` is False)."""
        pr = self.prs[key]
        pr["state"], pr["merged"], pr["updated_at"] = "closed", how == "merged", self.tick()
        if event:
            for kind in (("merged", "closed") if how == "merged" else ("closed",)):
                pr["timeline"].append({"id": self.ident(), "event": kind, "actor": {"login": self.me}, "created_at": self.tick()})

    def _search(self, params: dict):
        terms = params.get("q", "").split()
        repos = [t[5:] for t in terms if t.startswith("repo:")]
        since = next((t[len("updated:>="):] for t in terms if t.startswith("updated:>=")), None)
        created_before = next((t[len("created:<"):] for t in terms if t.startswith("created:<")), None)
        who = "review" if "review-requested:@me" in terms else "assignee"
        rows = [p for p in self.prs.values() if p["state"] == "open" and (not repos or p["repo"] in repos) and (since is None or p["updated_at"] >= since)
                and (created_before is None or p["created_at"] < created_before) and (who == "review" or p["assignee"] == self.me)]
        rows.sort(key=lambda p: (p["updated_at"], p["repo"], p["number"]), reverse=params.get("order") == "desc")
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
    assert "event-73" not in texts, "a merged event is the closed event's twin, never its own message"
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


async def test_a_backward_read_lists_only_what_is_older_newest_first(github):
    gh = github.gh
    for n in range(1, 4):
        gh.comment(PR, f"c{n}", user="dana")
    gh.comment("octo/app#8", "other old", user="lee")
    bound_comment = gh.comment(PR, "c4", user="dana")
    gh.comment("octo/app#8", "other new", user="lee")
    gh.pr("octo/app#9")
    gh.comment("octo/app#9", "created after", user="lee")
    bound = datetime.strptime(bound_comment["created_at"], "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=timezone.utc)
    gh.calls.clear()
    async with _source(github.base) as s:
        page = await s.fetch(None, page_size=3, narrow={"before": bound})
    search = next(p for m, p in gh.calls if p.startswith("/search/issues"))
    assert f"created:<{bound_comment['created_at']}" in search and "order=desc" in search and "per_page=3" in search
    assert not any("octo/app/issues/9" in p or "octo/app/pulls/9" in p for _, p in gh.calls), "a PR created after the bound is never read"
    assert [i.data.text for i in page.items] == ["other old", "c3", "c2"]
    assert all(i.data.sent_at < bound for i in page.items)
    assert page.next_cursor is None and page.resume_cursor is None


async def test_a_backward_read_leaves_the_forward_read_alone(github):
    gh = github.gh
    for n in range(1, 4):
        gh.comment(PR, f"c{n}", user="dana")
    forward, resume, _ = await _all(_source(github.base))
    newest = max(i.data.sent_at for i in forward)
    async with _source(github.base) as s:
        await s.fetch(None, page_size=2, narrow={"before": newest})
    again, resume_again, _ = await _all(_source(github.base))
    assert [i.origin for i in again] == [i.origin for i in forward]
    assert [i.data.text for i in forward] == ["c1", "c2", "c3"]
    gh.calls.clear()
    await _all(_source(github.base), cursor=resume)
    assert not any("created:<" in p for _, p in gh.calls), "the forward search never carries the backward bound"


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


# ── lists past one page ──────────────────────────────────────────────────────


async def test_a_list_past_one_page_follows_the_link_header(github):
    gh = github.gh
    gh.list_page = 2
    for n in range(5):
        gh.comment(PR, f"c{n}", user="dana")
    items, _, _ = await _all(_source(github.base))
    assert [i.data.text for i in items] == [f"c{n}" for n in range(5)]
    assert sum(1 for _, p in gh.calls if p.startswith("/repos/octo/app/issues/7/comments")) == 3


# ── how a PR ends ────────────────────────────────────────────────────────────


async def test_merged_closed_and_unassigned_you_end_the_conversation_and_reopened_does_not(github):
    gh = github.gh
    pr = gh.pr(PR)
    pr["timeline"] += [
        {"id": 81, "event": "closed", "actor": {"login": "dana"}, "created_at": gh.tick()},
        {"id": 82, "event": "reopened", "actor": {"login": "dana"}, "created_at": gh.tick()},
        {"id": 83, "event": "unassigned", "actor": {"login": "dana"}, "assignee": {"login": "lee"}, "created_at": gh.tick()},
        {"id": 84, "event": "unassigned", "actor": {"login": "dana"}, "assignee": {"login": ME}, "created_at": gh.tick()},
    ]
    gh.clock += 60  # a merge well after the earlier close, not its twin
    pr["timeline"] += [
        {"id": 85, "event": "merged", "actor": {"login": "dana"}, "created_at": gh.tick()},
    ]
    items, _, _ = await _all(_source(github.base))
    got = {i.origin.key: (i.data.text, i.data.ends_conversation) for i in items}
    assert by_key_mark(items) == {"event-81": "closed", "event-82": None, "event-84": None}
    assert got == {
        "event-81": ("closed by dana", True),
        "event-82": ("reopened", False),
        "event-84": ("dana unassigned you", True),
    }, "someone else's unassignment is bookkeeping"


async def test_a_pr_that_leaves_the_search_ends_once(github):
    gh = github.gh
    gh.comment(PR, "hi", user="dana")
    gh.comment("octo/app#8", "other", user="dana")
    _, resume, _ = await _all(_source(github.base))
    gh.end(PR, "merged")
    gh.prs[PR]["updated_at"] = "2000-01-01T00:00:00Z"  # left the narrowed search without a fresh update
    items, resume, _ = await _all(_source(github.base), cursor=resume)
    ended = [i for i in items if i.data.ends_conversation]
    timeline_ids = {f"event-{e['id']}" for e in gh.prs[PR]["timeline"]}
    assert len(ended) == 1 and ended[0].origin.key in timeline_ids and ended[0].data.conversation.key == PR
    again, _, _ = await _all(_source(github.base), cursor=resume)
    assert not any(i.data.ends_conversation for i in again), "a PR's end is handed out once"


async def test_a_pr_gone_without_a_timeline_event_ends_on_its_state(github):
    gh = github.gh
    gh.comment(PR, "hi", user="dana")
    _, resume, _ = await _all(_source(github.base))
    gh.end(PR, "closed", event=False)
    items, _, _ = await _all(_source(github.base), cursor=resume)
    (ended,) = [i for i in items if i.data.ends_conversation]
    assert ended.origin.key == f"ended-{PR}-closed" and ended.data.text == "closed" and ended.data.mark.key == "closed"


async def test_seen_is_capped_and_the_cursor_stays_bounded(github, monkeypatch):
    module = asset_module("github_pr")
    keys = [f"some-long-owner-name/some-long-repo-name#{n}" for n in range(1000)]
    cursor = module._fit("2026-01-01T00:00:00+00:00", keys)
    state = module._decode(cursor)
    assert len(cursor) <= module.MAX_CURSOR_LENGTH and 0 < len(state["seen"]) <= module.SEEN_CAP
    assert state["seen"][-1] == keys[-1], "the newest keys are the ones kept"
    old = module._encode({"mark": "2026-01-01T00:00:00+00:00"})
    assert module._decode(old)["mark"], "a cursor from before `seen` still decodes"


# ── acting ───────────────────────────────────────────────────────────────────


def test_the_actions_are_declared():
    by_id = {a.id: a for a in GithubPrSource.actions}
    assert list(by_id) == ["approve", "request_changes", "merge", "close"]
    assert by_id["request_changes"].needs_text and by_id["request_changes"].label == "Request changes"
    assert by_id["merge"].destructive and by_id["merge"].confirm == "Merge this pull request into its base?"
    assert by_id["close"].destructive and by_id["close"].icon_name == "Archive"


async def test_approve_and_request_changes_come_back_keyed_as_the_review(github):
    gh = github.gh
    gh.pr(PR)
    async with _source(github.base) as s:
        approved = await s.act(s.conversation_origin(PR), "approve")
        asked = await s.act(s.conversation_origin(PR), "request_changes", "rename it")
    assert [p["event"] for p in gh.posts] == ["APPROVE", "REQUEST_CHANGES"]
    assert gh.prs[PR]["reviews"][-1]["body"] == "rename it"
    items, _, _ = await _all(_source(github.base))
    keys = {i.origin.key for i in items}
    assert approved.origin.key in keys and asked.origin.key in keys and approved.origin.key.startswith("review-")
    assert approved.data.text == f"{ME} approved" and asked.data.text == "rename it"
    assert (approved.data.mark.key, asked.data.mark.key) == ("approved", "changes_requested"), "the echo carries the read's mark"
    done = {a.id: a.done_mark for a in GithubPrSource.actions}
    assert (done["approve"], done["request_changes"], done["merge"]) == ("approved", "changes_requested", "")


async def test_merge_and_close_hit_github_and_leave_the_event_to_the_poll(github):
    gh = github.gh
    gh.pr(PR)
    gh.pr("octo/app#8")
    async with _source(github.base) as s:
        assert await s.act(s.conversation_origin(PR), "merge") is None
        assert await s.act(s.conversation_origin("octo/app#8"), "close") is None
    assert ("PUT", "/repos/octo/app/pulls/7/merge") in gh.calls and ("PATCH", "/repos/octo/app/pulls/8") in gh.calls
    assert gh.prs[PR]["merged"] and gh.prs["octo/app#8"]["state"] == "closed"


async def test_reviewing_your_own_pr_says_github_forbids_it(github):
    module = asset_module("github_pr")
    github.gh.pr(PR)["author"] = ME
    async with _source(github.base) as s:
        for action, text in (("approve", ""), ("request_changes", "x")):
            with pytest.raises(module.OwnPullRequest, match="GitHub does not let you review your own pull request"):
                await s.act(s.conversation_origin(PR), action, text)


async def test_an_unmergeable_pr_says_so_and_request_changes_needs_text(github):
    module = asset_module("github_pr")
    github.gh.pr(PR)["mergeable"] = False
    async with _source(github.base) as s:
        with pytest.raises(module.MergeBlocked, match="not mergeable"):
            await s.act(s.conversation_origin(PR), "merge")
        with pytest.raises(ValueError):
            await s.act(s.conversation_origin(PR), "request_changes", "  ")


async def test_act_takes_the_conversation_as_the_surface_sends_it(github):
    """The surface acts with a message's namespace (``<account>/<PR>``) and the PR as the key."""
    from flow_sdk.sources.values.origin import CloudOrigin

    gh = github.gh
    gh.pr(PR)
    async with _source(github.base) as s:
        conversation = CloudOrigin(kind="github_pr", namespace=f"{ME}/{PR}", key=PR)
        approved = await s.act(conversation, "approve")
    assert approved.origin.key.startswith("review-") and approved.data.conversation.key == PR
    assert gh.posts[-1] == {"to": PR, "event": "APPROVE"}


# ── how messages read ────────────────────────────────────────────────────────


async def test_a_line_comment_says_where_it_is_and_its_reply_does_not(github):
    gh = github.gh
    root = gh.review_comment(PR, "off by one?", user="dana")
    root.update(path="calc.py", line=6, diff_hunk="@@ -1,6 +1,6 @@\n def f():\n-    a = 1\n+    a = 2\n     b = 3\n     return a + b")
    gh.review_comment(PR, "fixed", user=ME, in_reply_to=root["id"])
    items, _, _ = await _all(_source(github.base))
    by_key = {i.origin.key: i.data.text for i in items}
    assert by_key[f"review-comment-{root['id']}"] == "calc.py:6\n│ +    a = 2\n│      b = 3\n│      return a + b\noff by one?"
    assert by_key[f"review-comment-{root['id'] + 1}"] == "fixed"


async def test_an_empty_commented_review_is_noise_and_a_worded_one_is_not(github):
    gh = github.gh
    pr = gh.pr(PR)
    pr["reviews"] += [
        {"id": 61, "user": {"login": "dana"}, "state": "COMMENTED", "body": "", "submitted_at": gh.tick()},
        {"id": 62, "user": {"login": "dana"}, "state": "COMMENTED", "body": "a few notes", "submitted_at": gh.tick()},
        {"id": 63, "user": {"login": "dana"}, "state": "CHANGES_REQUESTED", "body": "", "submitted_at": gh.tick()},
    ]
    items, _, _ = await _all(_source(github.base))
    texts = {i.origin.key: i.data.text for i in items}
    assert "review-61" not in texts and texts["review-62"] == "a few notes" and texts["review-63"] == "dana requested changes"


async def test_a_review_is_marked_by_its_state_and_a_comment_is_not(github):
    gh = github.gh
    pr = gh.pr(PR)
    pr["reviews"] += [
        {"id": 64, "user": {"login": "dana"}, "state": "APPROVED", "body": "ship it", "submitted_at": gh.tick()},
        {"id": 65, "user": {"login": "dana"}, "state": "CHANGES_REQUESTED", "body": "", "submitted_at": gh.tick()},
        {"id": 66, "user": {"login": "dana"}, "state": "DISMISSED", "body": "", "submitted_at": gh.tick()},
        {"id": 67, "user": {"login": "dana"}, "state": "COMMENTED", "body": "a few notes", "submitted_at": gh.tick()},
    ]
    items, _, _ = await _all(_source(github.base))
    marks = {i.origin.key: (i.data.mark.key, i.data.mark.label, i.data.mark.tone) if i.data.mark else None for i in items}
    assert marks == {
        "review-64": ("approved", "Approved", "positive"),
        "review-65": ("changes_requested", "Changes requested", "negative"),
        "review-66": ("dismissed", "Dismissed", "neutral"),
        "review-67": None,
    }


async def test_ci_is_sent_by_the_check_app_else_ci(github):
    gh = github.gh
    gh.pr("octo/app#1")["checks"] += [{"id": 1, "status": "completed", "conclusion": "success", "completed_at": gh.tick(), "app": {"name": "GitHub Actions"}}]
    gh.pr("octo/app#2")["checks"] += [{"id": 2, "status": "completed", "conclusion": "success", "completed_at": gh.tick()}]
    items, _, _ = await _all(_source(github.base))
    senders = {i.data.conversation.key: i.data.sender.name for i in items if i.origin.key.startswith("check-")}
    assert senders == {"octo/app#1": "GitHub Actions", "octo/app#2": "CI"}


def test_every_action_icon_resolves_in_the_icon_registry():
    from flow_sdk.icons.registry import IconRegistry

    registry = IconRegistry()
    unresolved = [a.icon_name for a in GithubPrSource.actions if registry.resolve(a.icon_name) is None]
    assert not unresolved, f"icons the packs do not know: {unresolved}"


async def test_a_merge_is_one_message_keyed_on_its_closed_event(github):
    gh = github.gh
    gh.pr(PR)
    gh.end(PR, "merged")  # merged + closed, a second apart
    gh.prs[PR]["state"] = "open"  # still listed by the search this pass
    merged_id, closed_id = (e["id"] for e in gh.prs[PR]["timeline"])
    items, _, _ = await _all(_source(github.base))
    ends = [(i.origin.key, i.data.text) for i in items if i.data.ends_conversation]
    assert ends == [(f"event-{closed_id}", f"merged by {ME}")], "one merge, one message"
    assert f"event-{merged_id}" not in {i.origin.key for i in items}

    gh.prs[PR]["timeline"] = [e for e in gh.prs[PR]["timeline"] if e["event"] == "closed"]  # the merged event lags
    lagging, _, _ = await _all(_source(github.base))
    assert [(i.origin.key, i.data.text) for i in lagging if i.data.ends_conversation] == ends, "the same key either way"


async def test_a_merged_pr_without_its_closed_event_yet_ends_on_its_state(github):
    gh = github.gh
    gh.comment(PR, "hi", user="dana")
    _, resume, _ = await _all(_source(github.base))
    gh.end(PR, "merged")
    gh.prs[PR]["timeline"] = [e for e in gh.prs[PR]["timeline"] if e["event"] == "merged"]
    items, _, _ = await _all(_source(github.base), cursor=resume)
    assert [(i.origin.key, i.data.text) for i in items if i.data.ends_conversation] == [(f"ended-{PR}-merged", "merged")]


async def test_a_merged_pr_that_left_the_search_ends_as_merged(github):
    gh = github.gh
    gh.comment(PR, "hi", user="dana")
    _, resume, _ = await _all(_source(github.base))
    gh.end(PR, "merged")
    items, _, _ = await _all(_source(github.base), cursor=resume)
    assert [(i.data.text, i.data.mark.label, i.data.mark.tone) for i in items if i.data.ends_conversation] == [(f"merged by {ME}", "Merged", "positive")]


def by_key_mark(items):
    return {i.origin.key: i.data.mark.key if i.data.mark else None for i in items}
