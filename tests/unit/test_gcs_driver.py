"""The GCS driver, against a real socket serving the JSON API's own response shapes.

GCS sits between the two remote-bytes sources that exist, and these pin the difference:

* there is NO change log, so every poll is one authoritative enumeration diffed against the
  last — and a `generation` that did not move costs no download;
* absence from that enumeration IS deletion, which is what lets this driver fill
  `tombstones` where a feed never may;
* GCS reports no move, so a rename arrives as a tombstone plus a new ref, never a `renames`
  entry that would carry identity to the wrong object;
* an object name is a PATH, so the local layout mirrors it and `origin_id` needs no sidecar —
  and a name that tries to escape that layout is refused rather than coerced.

A stubbed httpx client would let the pagination and the diff pass while broken, so this uses
the same loopback server the other driver tests do.
"""

from __future__ import annotations

import json
from urllib.parse import parse_qs, unquote, urlparse

import pytest

from flow_sdk.ingest.driver import SegmentCursorView
from flow_sdk.ingest.drivers.gcs import GoogleCloudStorageDriver
from tests.unit._ingest_helpers import local_http_server, make_data_source, with_token

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _source(tmp_path, base: str, **config):
    return make_data_source(
        "gcs",
        name="Bucket test",
        config={"bucket": "acme-docs", "base_url": base, "cache_root": str(tmp_path / "cache"), **config},
    )


def _view(state: dict | None = None, segment: str = "/") -> SegmentCursorView:
    return SegmentCursorView(segment_key=segment, state=state or {}, first_run=not state)


def _obj(name: str, generation: str = "1") -> dict:
    return {"name": name, "generation": generation, "size": "12", "updated": "2026-01-01T00:00:00Z"}


class _Bucket:
    """A minimal GCS that records what it was asked for."""

    def __init__(self, objects=(), *, pages=None):
        self.objects = list(objects)
        #: Optional list of pages, to exercise `nextPageToken`.
        self.pages = pages
        self.listed: list[dict] = []
        self.downloaded: list[str] = []

    def __call__(self, path, headers):
        url = urlparse(path)
        query = {k: v[0] for k, v in parse_qs(url.query).items()}
        if url.path.endswith("/o") or url.path.endswith("/o/"):
            self.listed.append(query)
            # One listing implementation: an unpaged bucket is simply a bucket of one page,
            # so prefix filtering and `nextPageToken` are never two different servers.
            pages = self.pages if self.pages is not None else [self.objects]
            index = int(query.get("pageToken") or 0)
            prefix = query.get("prefix") or ""
            body: dict = {"items": [o for o in pages[index] if o["name"].startswith(prefix)]}
            if index + 1 < len(pages):
                body["nextPageToken"] = str(index + 1)
            return 200, json.dumps(body).encode(), {}
        if "/o/" in url.path:
            name = unquote(url.path.split("/o/", 1)[1])
            self.downloaded.append(name)
            return 200, f"bytes of {name}".encode(), {}
        if url.path.endswith("/b/acme-docs"):
            return 200, json.dumps({"name": "acme-docs"}).encode(), {}
        return 404, b"{}", {}


@pytest.fixture
def driver(monkeypatch):
    return with_token(monkeypatch, GoogleCloudStorageDriver)


# ── the first poll ───────────────────────────────────────────────────────────


async def test_a_first_poll_downloads_every_object_into_the_cache(driver, tmp_path):
    bucket = _Bucket([_obj("handbook/intro.md"), _obj("handbook/policy/leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        result = await driver.fetch(source, _view())

    root = driver.cache_root(source)
    assert sorted(str(p.relative_to(root)) for p in root.rglob("*.md")) == [
        "handbook/intro.md", "handbook/policy/leave.md",
    ]
    assert len(result.refs) == 2 and not result.tombstones
    assert result.next_state == {"handbook/intro.md": "1", "handbook/policy/leave.md": "1"}
    assert (root / "handbook" / "intro.md").read_text() == "bytes of handbook/intro.md"


async def test_the_local_layout_mirrors_the_object_name(driver, tmp_path):
    """An object name IS a path — which is why identity needs no sidecar."""
    bucket = _Bucket([_obj("a/b/c/deep.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        (ref,) = (await driver.fetch(source, _view())).refs

    assert driver.origin_id_for(source, ref) == "gcs:acme-docs/a/b/c/deep.md"


# ── the second poll: the whole point ─────────────────────────────────────────


async def test_an_unchanged_generation_costs_no_download(driver, tmp_path):
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.fetch(source, _view())
        bucket.downloaded.clear()
        second = await driver.fetch(source, _view(first.next_state))

    assert second.unchanged is True
    assert bucket.downloaded == [], "a listing that did not move must not re-fetch bytes"


async def test_a_new_generation_re_downloads_only_that_object(driver, tmp_path):
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.fetch(source, _view())
        bucket.objects = [_obj("intro.md"), _obj("leave.md", generation="2")]
        bucket.downloaded.clear()
        second = await driver.fetch(source, _view(first.next_state))

    assert bucket.downloaded == ["leave.md"]
    assert len(second.refs) == 1 and second.refs[0].endswith("leave.md")


async def test_an_object_that_vanished_is_a_tombstone(driver, tmp_path):
    """Absence from an AUTHORITATIVE enumeration is deletion — unlike a feed's silence."""
    bucket = _Bucket([_obj("intro.md"), _obj("leave.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.fetch(source, _view())
        bucket.objects = [_obj("intro.md")]
        second = await driver.fetch(source, _view(first.next_state))

    assert len(second.tombstones) == 1 and second.tombstones[0].endswith("leave.md")
    assert "leave.md" not in second.next_state


async def test_a_rename_is_a_tombstone_and_a_new_ref_never_a_rename_entry(driver, tmp_path):
    """GCS has no move — a rename is a copy plus a delete, and that is what it reports."""
    bucket = _Bucket([_obj("old.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        first = await driver.fetch(source, _view())
        bucket.objects = [_obj("new.md")]
        second = await driver.fetch(source, _view(first.next_state))

    assert second.renames == {}, "inventing a rename would carry identity to the wrong object"
    assert len(second.refs) == 1 and second.refs[0].endswith("new.md")
    assert len(second.tombstones) == 1 and second.tombstones[0].endswith("old.md")


# ── shape and safety ─────────────────────────────────────────────────────────


async def test_pagination_is_followed(driver, tmp_path):
    bucket = _Bucket(pages=[[_obj("one.md")], [_obj("two.md")], [_obj("three.md")]])
    with local_http_server(bucket) as base:
        result = await driver.fetch(_source(tmp_path, base), _view())

    assert len(result.refs) == 3 and len(bucket.listed) == 3


async def test_a_prefix_is_a_segment_and_bounds_the_listing(driver, tmp_path):
    bucket = _Bucket([_obj("handbook/intro.md"), _obj("archive/old.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base, prefixes=["handbook/"])
        segments = await driver.segments(source)
        result = await driver.fetch(source, _view(segment="handbook/"))

    assert [s.key for s in segments] == ["handbook/"]
    assert bucket.listed[-1]["prefix"] == "handbook/"
    assert len(result.refs) == 1 and result.refs[0].endswith("handbook/intro.md")


async def test_a_name_that_would_escape_the_cache_is_refused(driver, tmp_path):
    bucket = _Bucket([_obj("../../etc/passwd"), _obj("fine.md")])
    with local_http_server(bucket) as base:
        source = _source(tmp_path, base)
        result = await driver.fetch(source, _view())

    assert len(result.refs) == 1 and result.refs[0].endswith("fine.md")
    assert not (driver.cache_root(source).parent.parent / "etc" / "passwd").exists()


async def test_a_directory_placeholder_is_not_a_document(driver, tmp_path):
    bucket = _Bucket([_obj("handbook/"), _obj("handbook/intro.md")])
    with local_http_server(bucket) as base:
        result = await driver.fetch(_source(tmp_path, base), _view())

    assert len(result.refs) == 1 and result.refs[0].endswith("intro.md")


async def test_a_missing_bucket_is_a_config_error_named_by_its_field(driver, tmp_path):
    from flow_sdk.ingest.health import SourceError

    with local_http_server(_Bucket()) as base:
        source = _source(tmp_path, base)
        source.config = {**source.config, "bucket": ""}
        with pytest.raises(SourceError) as caught:
            await driver.fetch(source, _view())
    assert "bucket" in str(caught.value)


async def test_verify_says_what_to_do_when_there_is_no_credential(tmp_path, monkeypatch):
    driver = with_token(monkeypatch, GoogleCloudStorageDriver, token="")
    with local_http_server(_Bucket()) as base:
        verdict = await driver.verify(_source(tmp_path, base))
    assert verdict.ready is False and "Connect Google" in verdict.detail


async def test_verify_passes_when_the_bucket_answers(driver, tmp_path):
    with local_http_server(_Bucket()) as base:
        verdict = await driver.verify(_source(tmp_path, base))
    assert verdict.ready is True
