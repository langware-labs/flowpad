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


async def test_reflect_off_the_spec_list_falls_to_the_spec_default_on_create():
    """A folder source created through the API with the row default `record`
    has no reflector for the refs its driver returns; the spec's head is what
    the dialog would have picked."""
    await DataSourceSpec(name="tree_provider", title="Tree", reflect=["none", "copy"]).save(notify=False)
    src = make_data_source(provider="tree_provider", config={"root": "/tmp/x"})
    assert src.reflect == "record"
    await src.save(notify=False)
    assert src.reflect == "none"

    chosen = make_data_source(provider="tree_provider", config={"root": "/tmp/y"}, reflect="copy")
    await chosen.save(notify=False)
    assert chosen.reflect == "copy", "a mode the spec offers is kept as given"
