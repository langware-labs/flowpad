"""The ``gcs`` data source, against a real socket serving the JSON API's own response shapes.

GCS sits between the two remote-bytes sources, and these pin the difference: there is NO change
log, so every pass is one authoritative enumeration diffed against the last — a ``generation``
that did not move costs no download; absence from that enumeration IS deletion; GCS reports no
move, so a rename is a tombstone plus a new ref; and an object name is a PATH, so the cache
mirrors it — and a name that tries to escape the cache is refused rather than coerced.
"""
from __future__ import annotations

import json
from urllib.parse import parse_qs, unquote, urlparse

import pytest
from pydantic import SecretStr

from flow_sdk.ingest.health import SourceHealth, classify
from flow_sdk.ingest.sources import source_type
from flow_sdk.sources.binding import SourceBinding
from flow_sdk.sources.credentials import AuthShape, Credentials
from flow_sdk.sources.errors import NotFound, Rejected
from flow_sdk.sources.providers.gcs import GcsSource
from flow_sdk.sources.testing import Subject, checks_for
from tests.unit._ingest_helpers import local_http_server, make_data_source, position

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TOKEN = Credentials(shape=AuthShape.CONNECTOR, token=SecretStr("tok"))


def _credentials(credentials):
    async def resolve(_row):
        return credentials

    return resolve


@pytest.fixture
def driver(monkeypatch):
    gcs = source_type("gcs")
    monkeypatch.setattr(gcs, "credentials_for", _credentials(TOKEN))
    return gcs


def _source(tmp_path, base: str, **config):
    return make_data_source(
        "gcs", name="Bucket test", config={"bucket": "acme-docs", "base_url": base, "cache_root": str(tmp_path / "cache"), **config}
    )


def _view(state: dict | None = None, segment: str = "/"):
    return position(segment_key=segment, prior=state or {})


def _obj(name: str, generation: str = "1") -> dict:
    return {"name": name, "generation": generation, "size": str(len(f"bytes of {name}")), "updated": "2026-01-01T00:00:00Z"}


class _Bucket:
    """A minimal GCS that records what it was asked for."""

    def __init__(self, objects=(), *, pages=None, buckets=()):
        self.objects, self.buckets, self.pages = list(objects), list(buckets), pages
        self.listed: list[dict] = []
        self.listed_buckets: list[dict] = []
        self.downloaded: list[str] = []

    def __call__(self, path, headers):
        url = urlparse(path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path.endswith("/o"):
            self.listed.append(query)
            prefix = query.get("prefix") or ""
            if self.pages is not None:
                index = int(query.get("pageToken") or 0)
                items, more = self.pages[index], index + 1 < len(self.pages)
                following = str(index + 1)
            else:
                matching = [o for o in self.objects if o["name"].startswith(prefix)]
                start, size = int(query.get("pageToken") or 0), int(query.get("maxResults") or 1000)
                items, more, following = matching[start : start + size], start + size < len(matching), str(start + size)
            body: dict = {"items": [o for o in items if o["name"].startswith(prefix)]}
            if more:
                body["nextPageToken"] = following
            return 200, json.dumps(body).encode(), {}
        if "/o/" in url.path:
            name = unquote(url.path.split("/o/", 1)[1])
            found = next((o for o in self.objects if o["name"] == name), None)
            if found is None:
                return 404, b"{}", {}
            if query.get("alt") == "media":
                self.downloaded.append(name)
                return 200, f"bytes of {name}".encode(), {}
            return 200, json.dumps(found).encode(), {}
        if url.path.endswith("/b"):
            self.listed_buckets.append(query)
            return 200, json.dumps({"items": self.buckets}).encode(), {}
        if url.path.endswith("/b/acme-docs"):
            return 200, json.dumps({"name": "acme-docs"}).encode(), {}
        return 404, b"{}", {}


# ── the contract ─────────────────────────────────────────────────────────────

SEEDED = [_obj("a.md"), _obj("b/c.md"), _obj("d.md")]


@pytest.mark.parametrize("check", checks_for(GcsSource), ids=str)
async def test_conformance(check):
    with local_http_server(_Bucket(SEEDED)) as base:
        binding = SourceBinding(source_id="ds-gcs", config={"bucket": "acme-docs", "base_url": base}, credentials=TOKEN)
        origins = tuple(GcsSource(binding).origin(o["name"]) for o in SEEDED)
        await check.run(Subject(source=lambda: GcsSource(binding), seeded=origins))


async def test_open_streams_an_objects_bytes_and_a_missing_one_is_not_found():
    with local_http_server(_Bucket(SEEDED)) as base:
        async with GcsSource(SourceBinding(config={"bucket": "acme-docs", "base_url": base}, credentials=TOKEN)) as source:
            item = await source.get(source.origin("b/c.md"))
            async with source.open(item, chunk_size=4) as chunks:
                parts = [chunk async for chunk in chunks]
            missing = item.model_copy(update={"origin": source.origin("nope.md")})
            with pytest.raises(NotFound):
                async with source.open(missing):
                    pass
    assert b"".join(parts) == b"bytes of b/c.md" and max(map(len, parts)) <= 4
    assert (item.data.size, item.data.generation) == (15, "1"), "size and generation survive the listing"


# ── the first pass ───────────────────────────────────────────────────────────


async def test_a_first_pass_downloads_every_object_into_the_cache(driver, tmp_path):
    with local_http_server(_Bucket([_obj("handbook/intro.md"), _obj("handbook/policy/leave.md")])) as base:
        result = await driver.traverse(source := _source(tmp_path, base), _view())

    root = (tmp_path / "cache").resolve()
    assert sorted(str(p.relative_to(root)) for p in root.rglob("*.md")) == ["handbook/intro.md", "handbook/policy/leave.md"]
    assert len(result.refs) == 2 and not result.tombstones
    assert (root / "handbook" / "intro.md").read_text() == "bytes of handbook/intro.md"
    assert driver.origin_id_for(source, result.refs[0]).startswith("gcs:acme-docs/handbook/"), "the name IS the identity"


# ── the second pass: the whole point ─────────────────────────────────────────


async def test_an_unchanged_generation_costs_no_download(driver, tmp_path):
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        bucket.downloaded.clear()
        second = await driver.traverse(source, _view(first))
    assert second.unchanged is True and bucket.downloaded == []


async def test_a_new_generation_re_downloads_only_that_object(driver, tmp_path):
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        bucket.objects = [_obj("intro.md"), _obj("leave.md", generation="2")]
        bucket.downloaded.clear()
        second = await driver.traverse(source, _view(first))
    assert bucket.downloaded == ["leave.md"] and [r.rsplit("/", 1)[1] for r in second.refs] == ["leave.md"]


async def test_an_object_that_vanished_is_a_tombstone(driver, tmp_path):
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        bucket.objects = [_obj("intro.md")]
        second = await driver.traverse(source, _view(first))
    assert len(second.tombstones) == 1 and second.tombstones[0].endswith("leave.md")


async def test_a_rename_is_a_tombstone_and_a_new_ref_never_a_rename_entry(driver, tmp_path):
    bucket = _Bucket([_obj("old.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.traverse(source, _view())
        bucket.objects = [_obj("new.md")]
        second = await driver.traverse(source, _view(first))
    assert second.renames == {}, "inventing a rename would carry identity to the wrong object"
    assert second.refs[0].endswith("new.md") and second.tombstones[0].endswith("old.md")


# ── shape and safety ─────────────────────────────────────────────────────────


async def test_pagination_is_followed(driver, tmp_path):
    bucket = _Bucket(pages=[[_obj("one.md")], [_obj("two.md")], [_obj("three.md")]])
    bucket.objects = [o for page in bucket.pages for o in page]
    with local_http_server(bucket) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert len(result.refs) == 3 and len(bucket.listed) == 3


async def test_a_prefix_is_a_segment_and_bounds_the_listing(driver, tmp_path):
    bucket = _Bucket([_obj("handbook/intro.md"), _obj("archive/old.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base, prefixes=["handbook/"])
        segments = await driver.segments(source)
        result = await driver.traverse(source, _view(segment="handbook/"))
    assert [s.key for s in segments] == ["handbook/"] and bucket.listed[-1]["prefix"] == "handbook/"
    assert len(result.refs) == 1 and result.refs[0].endswith("handbook/intro.md")


async def test_a_name_that_would_escape_the_cache_is_refused(driver, tmp_path):
    with local_http_server(_Bucket([_obj("../../etc/passwd"), _obj("fine.md")])) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert len(result.refs) == 1 and result.refs[0].endswith("fine.md")
    assert not (tmp_path / "etc" / "passwd").exists()


async def test_a_directory_placeholder_is_not_a_document(driver, tmp_path):
    with local_http_server(_Bucket([_obj("handbook/"), _obj("handbook/intro.md")])) as base:
        result = await driver.traverse(_source(tmp_path, base), _view())
    assert len(result.refs) == 1 and result.refs[0].endswith("intro.md")


async def test_a_missing_bucket_is_a_config_error_named_by_its_field(driver, tmp_path):
    with local_http_server(_Bucket()) as base:
        with pytest.raises(Exception) as caught:
            await driver.traverse(_source(tmp_path, base, bucket=""), _view())
    assert classify(caught.value)[0] is SourceHealth.CONFIG_ERROR and "bucket" in str(caught.value)


async def test_verify_says_what_to_do_when_there_is_no_credential(driver, tmp_path, monkeypatch):
    monkeypatch.setattr(driver, "credentials_for", _credentials(Credentials()))
    with local_http_server(_Bucket()) as base:
        verdict = await driver.verify(_source(tmp_path, base))
    assert verdict.ready is False and "Connect Google" in verdict.detail


async def test_verify_passes_when_the_bucket_answers(driver, tmp_path):
    with local_http_server(_Bucket()) as base:
        assert (await driver.verify(_source(tmp_path, base))).ready is True


# ── the picker ───────────────────────────────────────────────────────────────


async def test_the_picker_offers_the_buckets_in_the_project(driver, tmp_path):
    bucket = _Bucket(buckets=[{"name": "acme-docs", "location": "US-CENTRAL1"}, {"name": "acme-logs"}])
    with local_http_server(bucket) as base:
        picks = await driver.choices(_source(tmp_path, base, project="acme-prod"), "bucket")
    assert [(c.id, c.name, c.detail) for c in picks] == [("acme-docs", "acme-docs", "us-central1"), ("acme-logs", "acme-logs", "")]
    assert bucket.listed_buckets[-1]["project"] == "acme-prod"


async def test_no_project_is_answered_before_any_request(driver, tmp_path):
    bucket = _Bucket(buckets=[{"name": "acme-docs"}])
    with local_http_server(bucket) as base:
        with pytest.raises(Rejected, match="GCP project"):
            await driver.choices(_source(tmp_path, base, bucket=""), "bucket")
    assert bucket.listed_buckets == [], "the cheapest question is asked first"


async def test_the_picker_answers_nothing_for_a_field_it_does_not_furnish(driver, tmp_path):
    with local_http_server(_Bucket()) as base:
        assert await driver.choices(_source(tmp_path, base, project="p"), "prefixes") == []
