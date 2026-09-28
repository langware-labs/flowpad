"""The ``jira`` data source against a loopback Jira: the contract, paging on Jira's own
``nextPageToken``, the high-water resume, ADF flattening, Basic auth, and what each failure needs.

Real sockets and real query strings, so the JQL the source composes is the JQL a server parses.
"""
from __future__ import annotations

import base64
import json
import re
from datetime import datetime, timedelta, timezone
from urllib.parse import parse_qs, urlsplit

import pytest
from pydantic import SecretStr

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import asset_module
from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.testing import local_http_server, make_data_source, position
from flow_sdk.sources import CloudOrigin
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, ResolvedSecrets
from flow_sdk.sources.testing import Subject, checks_for

module = asset_module("jira")
JiraSource = module.JiraSource

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

EMAIL, TOKEN = "ada@acme.test", "atl-token-1234"
JQL = "project = PROJ order by updated DESC"
_SINCE = re.compile(r'updated >= "(\d{4}/\d{2}/\d{2}(?: \d{2}:\d{2})?)"')


def adf(*paragraphs: str) -> dict:
    """A description as Jira Cloud sends one: an ADF doc, a paragraph per string."""
    return {
        "type": "doc",
        "version": 1,
        "content": [{"type": "paragraph", "content": [{"type": "text", "text": p}]} for p in paragraphs],
    }


def issue(n: int, updated: datetime, *, assignee: str | None = "Ada Lovelace", status: str = "To Do") -> dict:
    return {
        "id": str(10000 + n),
        "key": f"PROJ-{n}",
        "fields": {
            "summary": f"Issue number {n}",
            "description": adf(f"The body of issue {n}.", "Second paragraph."),
            "status": {"name": status},
            "assignee": {"displayName": assignee, "accountId": f"acc-{n}"} if assignee else None,
            "priority": {"name": "Medium"},
            "issuetype": {"name": "Task"},
            "labels": ["backend"] if n % 2 else [],
            "updated": updated.strftime("%Y-%m-%dT%H:%M:%S.000+0000"),
        },
    }


def seed(count: int, *, now: datetime | None = None) -> list[dict]:
    """``count`` issues updated a minute apart, the newest first; the first is unassigned."""
    now = now or datetime.now(timezone.utc)
    return [issue(n, now - timedelta(minutes=n), assignee=None if n == 1 else f"Person {n}") for n in range(1, count + 1)]


class _Jira:
    """The two routes the source reads, with Basic auth checked and every request recorded."""

    def __init__(self, issues: list[dict]):
        self.issues = issues
        self.requests: list[tuple[str, dict]] = []
        self.email, self.token = EMAIL, TOKEN

    def __call__(self, path, headers):
        url = urlsplit(path)
        params = {k: v[0] for k, v in parse_qs(url.query).items()}
        self.requests.append((url.path, params))
        expected = "Basic " + base64.b64encode(f"{self.email}:{self.token}".encode()).decode()
        if headers.get("Authorization") != expected:
            return 401, b'{"errorMessages":["unauthorized"]}', {"Content-Type": "application/json"}
        if url.path == "/rest/api/3/search/jql":
            return self._search(params)
        found = re.fullmatch(r"/rest/api/3/issue/([^/]+)", url.path)
        if found:
            hit = next((i for i in self.issues if found.group(1) in (i["id"], i["key"])), None)
            return (200, json.dumps(hit).encode(), _JSON) if hit else (404, b'{"errorMessages":["no issue"]}', _JSON)
        return 404, b"nope", {"Content-Type": "text/plain"}

    def _search(self, params: dict):
        jql = params.get("jql", "")
        if "BROKEN" in jql:
            return 400, b'{"errorMessages":["Error in the JQL Query"]}', _JSON
        if not re.search(r"\S", _ORDER_CUT.split(jql)[0]):
            return 400, b'{"errorMessages":["Unbounded JQL queries are not allowed here."]}', _JSON
        rows = sorted(self.issues, key=lambda i: i["fields"]["updated"], reverse=True)
        since = _SINCE.search(jql)
        if since:
            floor = datetime.strptime(since.group(1), "%Y/%m/%d %H:%M" if " " in since.group(1) else "%Y/%m/%d")
            rows = [i for i in rows if i["fields"]["updated"][:16].replace("-", "/").replace("T", " ") >= floor.strftime("%Y/%m/%d %H:%M")]
        start = int(params.get("nextPageToken", "tok-0").removeprefix("tok-"))
        size = int(params.get("maxResults", 50))
        page = rows[start : start + size]
        body: dict = {"issues": page, "isLast": start + size >= len(rows)}
        if not body["isLast"]:
            body["nextPageToken"] = f"tok-{start + size}"
        return 200, json.dumps(body).encode(), _JSON

    def searches(self) -> list[dict]:
        return [params for path, params in self.requests if path == "/rest/api/3/search/jql"]


_JSON = {"Content-Type": "application/json"}
_ORDER_CUT = re.compile(r"\border\s+by\b", re.IGNORECASE)


def secrets(email: str = EMAIL, token: str = TOKEN) -> ResolvedSecrets:
    return ResolvedSecrets(shape=AuthShape.SECRETS, values={"email": SecretStr(email), "api_token": SecretStr(token)})


@pytest.fixture
def jira():
    fake = _Jira(seed(5))
    with local_http_server(fake) as url:
        fake.url = url
        yield fake


def _source(site: str, jql: str = JQL, credentials: ResolvedSecrets | None = None) -> JiraSource:
    return JiraSource(SourceBinding(config={"site": site, "jql": jql}, credentials=credentials or secrets()))


@pytest.mark.parametrize("check", checks_for(JiraSource), ids=str)
async def test_conformance(check, jira):
    await check.run(Subject(
        source=lambda: _source(jira.url),
        seeded=tuple(CloudOrigin(kind="jira", namespace=jira.url, key=i["id"]) for i in jira.issues),
    ))


async def test_an_issue_dumps_as_one_flat_row(jira):
    async with _source(jira.url) as source:
        page = await source.fetch(page_size=10)
    rows = {item.data.key: item.data.model_dump() for item in page.items}
    assert list(rows) == [f"PROJ-{n}" for n in range(1, 6)], "Jira's own order (updated DESC) is kept"
    row = rows["PROJ-2"]
    assert (row["status"], row["assignee"], row["priority"], row["issue_type"]) == ("To Do", "Person 2", "Medium", "Task")
    assert row["title"] == "Issue number 2" and row["url"] == f"{jira.url}/browse/PROJ-2"
    assert row["text"] == "The body of issue 2.\nSecond paragraph."
    assert isinstance(row["published_at"], datetime) and row["published_at"].tzinfo is not None
    assert all(not isinstance(v, dict) for v in row.values()), "every column is a scalar"


async def test_unassigned_is_an_empty_string(jira):
    async with _source(jira.url) as source:
        first = (await source.fetch(page_size=1)).items[0]
    assert first.data.key == "PROJ-1" and first.data.assignee == ""


async def test_the_origin_is_the_id_and_links_to_the_issue(jira):
    async with _source(jira.url) as source:
        item = (await source.fetch(page_size=1)).items[0]
    assert (item.origin.key, item.origin.namespace, item.origin.url) == ("10001", jira.url, f"{jira.url}/browse/PROJ-1")


async def test_pages_follow_jiras_next_page_token(jira):
    keys, cursor = [], None
    async with _source(jira.url) as source:
        while True:
            page = await source.fetch(cursor, page_size=2)
            keys += [item.data.key for item in page.items]
            if page.next_cursor is None:
                assert page.resume_cursor, "the last page carries the resume point"
                break
            assert page.resume_cursor is None, "a page mid-traversal must not move the resume point"
            cursor = page.next_cursor
    assert keys == [f"PROJ-{n}" for n in range(1, 6)]
    assert [s.get("nextPageToken") for s in jira.searches()] == [None, "tok-2", "tok-4"]
    assert {s["maxResults"] for s in jira.searches()} == {"2"}


async def test_a_page_never_asks_for_more_than_jira_serves(jira):
    async with _source(jira.url) as source:
        await source.fetch(page_size=500)
    assert jira.searches()[-1]["maxResults"] == str(module.JIRA_MAX_RESULTS)


async def test_the_resume_narrows_the_jql_to_updated_since_the_mark_less_a_day(jira):
    async with _source(jira.url) as source:
        done = await source.fetch(page_size=50)
        await source.fetch(done.resume_cursor, page_size=50)
    jql = jira.searches()[-1]["jql"]
    newest = max(i["fields"]["updated"] for i in jira.issues)
    floor = (datetime.strptime(newest[:16], "%Y-%m-%dT%H:%M") - timedelta(days=1)).strftime("%Y/%m/%d %H:%M")
    assert jql == f'(project = PROJ) AND updated >= "{floor}" order by updated DESC'


async def test_a_resume_from_another_jql_reads_the_query_whole(jira):
    async with _source(jira.url, "project = OTHER order by updated DESC") as other:
        resume = (await other.fetch(page_size=50)).resume_cursor
    async with _source(jira.url) as source:
        await source.fetch(resume, page_size=50)
    assert "updated >=" not in jira.searches()[-1]["jql"]


def test_a_bare_order_by_gets_a_restriction_that_matches_everything():
    assert module._jql("order by updated DESC", None) == 'updated >= "1970/01/01" order by updated DESC'
    assert module._jql("project = PROJ", None) == "(project = PROJ)"


async def test_basic_auth_is_email_and_api_token_and_a_refusal_needs_a_person(jira):
    async with _source(jira.url) as source:
        await source.fetch(page_size=1)
    jira.token = "rotated"
    with pytest.raises(Exception) as caught:
        async with _source(jira.url) as source:
            await source.fetch(page_size=1)
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


async def test_missing_credentials_are_a_config_error(jira):
    with pytest.raises(Exception) as caught:
        async with JiraSource(SourceBinding(config={"site": jira.url, "jql": JQL})) as source:
            await source.fetch(page_size=1)
    assert "JIRA_API_TOKEN" in str(caught.value)


def test_adf_flattens_to_text_a_line_per_block():
    doc = {
        "type": "doc",
        "content": [
            {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Steps"}]},
            {"type": "paragraph", "content": [
                {"type": "text", "text": "Ask "}, {"type": "mention", "attrs": {"text": "@Ada"}},
                {"type": "text", "text": " first"}, {"type": "hardBreak"}, {"type": "text", "text": "then ship"},
            ]},
            {"type": "bulletList", "content": [
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "one"}]}]},
                {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "inlineCard", "attrs": {"url": "https://x.test"}}]}]},
            ]},
        ],
    }
    assert module.adf_text(doc) == "Steps\nAsk @Ada first\nthen ship\none\n\nhttps://x.test"
    assert module.adf_text(None) == "" and module.adf_text("plain v2 text ") == "plain v2 text"


async def test_a_traverse_windows_on_updated_and_resumes(jira):
    driver = DataDriver.loaded("jira")
    row = make_data_source("jira", name="PROJ issues", config={"site": jira.url, "jql": JQL})
    old = issue(9, datetime.now(timezone.utc) - timedelta(days=30))
    jira.issues.append(old)
    window = (datetime.now(timezone.utc) - timedelta(days=7)).isoformat()

    async def creds(_row):
        return secrets()

    driver_creds = driver.credentials_for
    driver.credentials_for = creds
    try:
        first = await driver.traverse(row, position(window_start=window))
        assert sorted(item.external_id for item in first.items) == sorted(i["id"] for i in jira.issues if i is not old)
        assert first.cursor and first.high_water
        again = await driver.traverse(row, position(first, window_start=window))
        assert "updated >=" in jira.searches()[-1]["jql"] and again.cursor == first.cursor
    finally:
        driver.credentials_for = driver_creds


async def test_a_bad_jql_is_the_persons_to_fix(jira):
    with pytest.raises(Exception) as caught:
        async with _source(jira.url, "project = BROKEN") as source:
            await source.fetch(page_size=1)
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR


async def test_the_driver_is_a_record_source_that_does_not_send():
    driver = await DataDriver.get("jira")
    assert (driver.family, driver.sends, driver.cls.identity_config_key) == ("record", False, "site")
