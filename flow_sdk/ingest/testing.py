"""Test support for a data source against the application: a row, and a segment position.

What a data source asset's own tests need beyond the contract kit (``flow_sdk.sources.testing``)
to drive the engine — importable from the SDK, so an asset folder's tests import nothing else.
"""
from __future__ import annotations

import re
import uuid
from datetime import datetime, timezone

from flow_sdk.sources.testing.http import Responder, local_http_server

_ISO_STAMP = re.compile(rb"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})")


def fresh_timestamps(body: bytes) -> bytes:
    """``body`` with every ISO-8601 timestamp set to now — a recorded fixture served inside a sync
    window that runs on the real clock."""
    return _ISO_STAMP.sub(datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ").encode(), body)


def make_data_source(provider: str = "rss", **fields):
    """A ``DataSource`` row (unsaved) with a unique account key and name — a source is an asset, and two
    sources of one name in one scope would claim the same ``agentic-assets/data_source/<name>`` folder."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415

    tag = uuid.uuid4().hex[:8]
    resolved = {"provider": provider, "account_key": f"acct-{tag}", "name": f"test source {tag}"}
    resolved.update(fields)
    return DataSource(**resolved)


def position(segment_key: str = "", prior=None, window_start=None, **_ignored):
    """Where a segment's traversal resumes: a prior pass's cursor and manifest, or the dict an older
    build left on the cursor row (lifted by the source class)."""
    from flow_sdk.ingest.driver_types import SegmentPass, SegmentPosition  # noqa: PLC0415

    if isinstance(prior, SegmentPass):
        return SegmentPosition(segment_key=segment_key, cursor=prior.cursor, manifest=dict(prior.manifest), window_start=window_start)
    prior = dict(prior or {})
    if "cursor" in prior or "manifest" in prior:
        return SegmentPosition(
            segment_key=segment_key, cursor=prior.get("cursor"), manifest=dict(prior.get("manifest") or {}), window_start=window_start
        )
    return SegmentPosition(segment_key=segment_key, legacy_state=prior, window_start=window_start)


__all__ = ["Responder", "fresh_timestamps", "local_http_server", "make_data_source", "position"]
