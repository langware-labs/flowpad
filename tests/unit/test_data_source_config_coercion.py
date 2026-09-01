"""``DataSource.save`` shapes ``config`` by the spec's field types — a URL sent
as a string where the manifest declares ``lines`` becomes a one-element list,
so the driver never iterates the characters of a URL."""
from __future__ import annotations

import pytest

from flow_sdk.builtin.data_source_spec import ConfigFieldSpec, DataSourceSpec
from tests.unit._ingest_helpers import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]


async def test_lines_csv_and_number_fields_are_coerced_on_save():
    await DataSourceSpec(
        name="probe_provider", title="Probe",
        config={"feed_urls": ConfigFieldSpec(type="lines"), "tags": ConfigFieldSpec(type="csv"), "depth": ConfigFieldSpec(type="number")},
    ).save(notify=False)
    src = make_data_source(provider="probe_provider", config={"feed_urls": "http://a/x\nhttp://b/y", "tags": "a, b", "depth": "3", "other": "kept"})
    await src.save(notify=False)
    assert src.config["feed_urls"] == ["http://a/x", "http://b/y"]
    assert src.config["tags"] == ["a", "b"] and src.config["depth"] == 3 and src.config["other"] == "kept"


async def test_a_list_stays_a_list_and_an_unknown_provider_changes_nothing():
    src = make_data_source(provider="nobody_registered_this", config={"feed_urls": "http://a/x"})
    await src.save(notify=False)
    assert src.config["feed_urls"] == "http://a/x"
