"""``JiraSource`` — the issues one JQL query matches on a Jira Cloud site, as a table.

REST v3's enhanced search (``/rest/api/3/search/jql``) with an API token over Basic auth. Each
issue is one record whose data dumps flat — ``key``, ``status``, ``assignee`` and the rest are
scalar columns — so a page is a slice of a table. Comments are not read: a thread of messages is a
different family, and would be a driver of its own.

**The cursor is Jira's own.** A page continuation carries ``nextPageToken``; nothing is scanned
and sliced on our side, so a pass over a large project costs one request per page.

**The resume cursor is a high-water mark on ``updated``.** The last page hands back the newest
``updated`` it saw; the next pass narrows the JQL to ``updated >= <mark>``. JQL reads a date in the
API user's profile timezone at minute precision, so the mark is moved back a day before it is
written: an issue seen again is free (the application's digest absorbs it), an issue missed is not.

**The identity is the issue id, never the key.** A key changes when an issue moves project; the
id does not.
"""
from __future__ import annotations

import base64
import binascii
import hashlib
import json
import re
from datetime import datetime, timedelta, timezone
from typing import Annotated, Any, ClassVar, Mapping, Optional

from pydantic import AwareDatetime, StringConstraints

from flow_sdk.sources import http
from flow_sdk.sources.base import CollectionSource, positive_int
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.config import SourceConfig
from flow_sdk.sources.errors import InvalidCursor, Rejected
from flow_sdk.sources.families import RecordSource
from flow_sdk.sources.values.items import RecordData, SourceItemSpec
from flow_sdk.sources.values.origin import CloudOrigin
from flow_sdk.sources.values.page import MAX_PAGE_SIZE, ChangePage
from flow_sdk.sources.values.query import DataQuery, RecordQuery

#: The fields one search asks for — exactly what ``JiraIssueData`` maps.
FIELDS = "summary,description,status,assignee,priority,issuetype,labels,updated"
#: The enhanced search's own ceiling on ``maxResults`` when fields are requested.
JIRA_MAX_RESULTS = 100
DEFAULT_JQL = "order by updated DESC"
#: How far the high-water mark is moved back: JQL dates are the API user's local time.
RESUME_MARGIN = timedelta(days=1)
MAX_CURSOR_LENGTH = 4096
_ORDER_BY = re.compile(r"\border\s+by\b", re.IGNORECASE)


class JiraQuery(RecordQuery):
    """The issues a JQL query matches."""

    spec_kind: ClassVar[str] = "source.query.jira"

    jql: str = DEFAULT_JQL


class JiraIssueData(RecordData):
    """One issue, flat: every field a scalar (or a list of labels), so it dumps as one table row."""

    spec_kind: ClassVar[str] = "ingest.record.jira"

    key: str
    status: str = ""
    #: The assignee's display name; ``""`` when nobody is assigned.
    assignee: str = ""
    priority: str = ""
    issue_type: str = ""
    labels: list[str] = []
    #: The issue's ``updated`` — the time the application windows and orders records by.
    published_at: Optional[AwareDatetime] = None


class JiraConfig(SourceConfig):
    """What a jira source is configured with."""

    site: Annotated[str, StringConstraints(pattern=r"^https?://")]
    jql: str = DEFAULT_JQL


class JiraSource(RecordSource, CollectionSource):

    Config = JiraConfig
    provider = "jira"
    durable_cursor = True
    identity_config_key = "site"
    supported_queries = (JiraQuery,)

    def __init__(self, binding: SourceBinding) -> None:
        super().__init__(binding)
        self._client: Any = None

    @property
    def site(self) -> str:
        return str(self.config.get("site") or "").rstrip("/")

    def query(self) -> JiraQuery:
        return JiraQuery(jql=str(self.config.get("jql") or "").strip() or DEFAULT_JQL)

    def origin(self, key: str, *within: str) -> CloudOrigin:
        """An issue id is unique within its site."""
        return super().origin(key, *(within or (self.site,)))

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
        self._check_query(query)
        limit = self.effective_page_size if page_size is None else positive_int(page_size, "page_size", MAX_PAGE_SIZE)
        owner = _query_token(query)
        token, since, mark = None, None, None
        if cursor is not None:
            state = _decode(cursor)
            if "resume" in state:
                # A mark from another JQL says nothing about this one: read it whole again.
                since = _stamp(state["resume"]) if state.get("q") == owner else None
            elif state.get("q") != owner:
                raise InvalidCursor("cursor does not belong to this query")
            else:
                token, since, mark = state.get("token"), _stamp(state.get("since")), _stamp(state.get("mark"))
        payload = await self._search(_jql(query.jql, since), limit, token)
        issues = [issue for issue in payload.get("issues") or [] if isinstance(issue, dict) and issue.get("id")]
        items = tuple(self._item(str(issue["id"]), issue) for issue in issues)
        stamps = [stamp for stamp in (item.data.published_at for item in items) if stamp is not None]
        mark = max([s for s in (mark, since, *stamps) if s is not None], default=None)
        following = payload.get("nextPageToken")
        if following and not payload.get("isLast", False):
            state = {"q": owner, "token": following, "since": _iso(since), "mark": _iso(mark)}
            return ChangePage(items=items, next_cursor=_encode(state))
        return ChangePage(items=items, resume_cursor=_encode({"q": owner, "resume": _iso(mark)}) if mark else None)

    async def _search(self, jql: str, limit: int, token: Optional[str]) -> dict:
        params: dict[str, Any] = {"jql": jql, "maxResults": min(limit, JIRA_MAX_RESULTS), "fields": FIELDS}
        if token:
            params["nextPageToken"] = token
        payload = await http.request_json(
            self._client, "GET", f"{self.site}/rest/api/3/search/jql",
            params=params, headers=self._headers(), hint="check the site, the JQL and the API token",
        )
        if not isinstance(payload, dict):
            raise Rejected("Jira search answered with something other than an object")
        return payload

    def _headers(self) -> dict:
        values = self.credentials.values
        email, token = values.get("email"), values.get("api_token")
        if email is None or token is None:
            raise Rejected("the jira credential needs JIRA_EMAIL and JIRA_API_TOKEN")
        pair = f"{email.get_secret_value()}:{token.get_secret_value()}".encode()
        return {"Authorization": "Basic " + base64.b64encode(pair).decode(), "Accept": "application/json"}

    async def _lookup(self, key: str) -> Optional[dict]:
        response = await http.request(
            self._client, "GET", f"{self.site}/rest/api/3/issue/{key}",
            params={"fields": FIELDS}, headers=self._headers(), ok_statuses=(404,), hint="check the site and the API token",
        )
        if response.status_code == 404:
            return None
        try:
            return response.json()
        except ValueError:
            return None

    async def _scan(self, query: Optional[DataQuery]) -> list[tuple[str, dict]]:
        """Every issue the query matches — what ``get`` and a caller that wants the whole table read."""
        jql = query.jql if isinstance(query, JiraQuery) else self.query().jql
        out, token = {}, None
        while True:
            payload = await self._search(_jql(jql, None), JIRA_MAX_RESULTS, token)
            out.update({str(i["id"]): i for i in payload.get("issues") or [] if isinstance(i, dict) and i.get("id")})
            token = payload.get("nextPageToken")
            if not token or payload.get("isLast", False):
                return sorted(out.items())

    def _item(self, key: str, raw: dict) -> SourceItemSpec:
        fields = raw.get("fields") or {}
        issue_key = str(raw.get("key") or key)
        browse = f"{self.site}/browse/{issue_key}"
        data = JiraIssueData(
            key=issue_key,
            title=fields.get("summary") or None,
            text=adf_text(fields.get("description")) or None,
            url=browse,
            status=_name(fields.get("status")),
            assignee=str((fields.get("assignee") or {}).get("displayName") or ""),
            priority=_name(fields.get("priority")),
            issue_type=_name(fields.get("issuetype")),
            labels=[str(label) for label in fields.get("labels") or []],
            published_at=_parse_time(fields.get("updated")),
        )
        return SourceItemSpec(origin=self.origin(key).model_copy(update={"url": browse}), data=data)


# ── helpers ──────────────────────────────────────────────────────────────────

#: ADF block nodes whose text ends a line.
_BLOCKS = frozenset({"paragraph", "heading", "blockquote", "codeBlock", "listItem", "rule", "tableRow", "mediaSingle", "panel"})


def adf_text(node: Any) -> str:
    """An Atlassian Document Format tree as plain text: its text nodes, a line per block. A plain
    string (a v2-style description) passes through."""
    if isinstance(node, str):
        return node.strip()
    parts: list[str] = []
    _walk(node, parts)
    return re.sub(r"\n{3,}", "\n\n", "".join(parts)).strip()


def _walk(node: Any, parts: list[str]) -> None:
    if isinstance(node, list):
        for child in node:
            _walk(child, parts)
        return
    if not isinstance(node, dict):
        return
    kind, attrs = node.get("type"), node.get("attrs") or {}
    if kind == "text":
        parts.append(str(node.get("text") or ""))
    elif kind == "hardBreak":
        parts.append("\n")
    elif kind in ("mention", "emoji"):
        parts.append(str(attrs.get("text") or attrs.get("shortName") or ""))
    elif kind in ("inlineCard", "blockCard"):
        parts.append(str(attrs.get("url") or ""))
    _walk(node.get("content"), parts)
    if kind in _BLOCKS:
        parts.append("\n")


def _jql(jql: str, since: Optional[datetime]) -> str:
    """``jql`` narrowed to issues updated since ``since`` (less the margin). The ORDER BY clause
    stays last, where JQL requires it. The enhanced search refuses a query with no restriction at
    all, so a bare ``order by`` gets one that matches every issue."""
    found = list(_ORDER_BY.finditer(jql))
    cut = found[-1].start() if found else len(jql)
    where, order = jql[:cut].strip(), jql[cut:].strip()
    clauses = [f"({where})"] if where else []
    if since is not None:
        floor = (since - RESUME_MARGIN).astimezone(timezone.utc)
        clauses.append(f'updated >= "{floor.strftime("%Y/%m/%d %H:%M")}"')
    if not clauses:
        clauses.append('updated >= "1970/01/01"')
    return " AND ".join(clauses) + (f" {order}" if order else "")


def _query_token(query: JiraQuery) -> str:
    return hashlib.blake2b(query.jql.encode(), digest_size=8).hexdigest()


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
        raise InvalidCursor("malformed cursor") from exc
    if not isinstance(state, dict) or not isinstance(state.get("q"), str):
        raise InvalidCursor("malformed cursor")
    return state


def _name(field: Any) -> str:
    return str(field.get("name") or "") if isinstance(field, dict) else ""


def _parse_time(value: Any) -> Optional[datetime]:
    """Jira's ``2026-07-30T11:00:00.000+0000``; a naive stamp is UTC."""
    if not isinstance(value, str) or not value:
        return None
    text = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", value.replace("Z", "+00:00"))
    try:
        parsed = datetime.fromisoformat(text)
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def _iso(value: Optional[datetime]) -> Optional[str]:
    return value.isoformat() if value is not None else None


def _stamp(value: Any) -> Optional[datetime]:
    if value is None:
        return None
    try:
        parsed = datetime.fromisoformat(str(value))
    except ValueError as exc:
        raise InvalidCursor("malformed cursor") from exc
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


__all__ = ["JiraIssueData", "JiraQuery", "JiraSource", "adf_text"]
