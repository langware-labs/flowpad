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


async def test_a_missing_required_field_refuses_the_create_naming_the_field():
    """The form already refuses it; this is the API's and an agent's copy of
    the rule — a `ValueError`, which the create route maps to a 400."""
    await DataSourceSpec(
        name="strict_provider", title="Strict",
        config={"root": ConfigFieldSpec(type="path", required=True), "note": ConfigFieldSpec()},
    ).save(notify=False)
    with pytest.raises(ValueError, match="config.root is required"):
        await make_data_source(provider="strict_provider", config={"note": "x"}).save(notify=False)
    with pytest.raises(ValueError, match="config.root is required"):
        await make_data_source(provider="strict_provider", config={"root": "   "}).save(notify=False)
    ok = make_data_source(provider="strict_provider", config={"root": "/tmp/x"})
    await ok.save(notify=False)
    assert ok.exist_in_db


async def test_a_required_field_with_a_default_may_be_omitted():
    await DataSourceSpec(
        name="defaulted_provider", title="Defaulted",
        config={"depth": ConfigFieldSpec(type="number", required=True, default=3)},
    ).save(notify=False)
    src = make_data_source(provider="defaulted_provider", config={})
    await src.save(notify=False)
    assert src.exist_in_db


async def test_a_value_off_the_pattern_is_refused_per_entry_after_coercion():
    """`lines` are split first, so the message names the entry at fault, not
    the whole blob — the form's rule (`source-form.ts`), applied here."""
    await DataSourceSpec(
        name="regex_provider", title="Regex",
        config={"feed_urls": ConfigFieldSpec(type="lines", pattern=r"^https?://")},
    ).save(notify=False)
    with pytest.raises(ValueError, match=r"config.feed_urls is not valid: ftp://b/y"):
        await make_data_source(provider="regex_provider", config={"feed_urls": "http://a/x\nftp://b/y"}).save(notify=False)
    src = make_data_source(provider="regex_provider", config={"feed_urls": "http://a/x"})
    await src.save(notify=False)
    assert src.config["feed_urls"] == ["http://a/x"]


async def test_an_existing_row_is_not_re_validated_on_re_save():
    """The poller re-saves every tick; a rule added to the spec after the row
    was minted must not turn that into an exception nobody reads."""
    await DataSourceSpec(name="lenient_provider", title="Lenient", config={"root": ConfigFieldSpec()}).save(notify=False)
    src = make_data_source(provider="lenient_provider", config={"root": "/tmp/x"})
    await src.save(notify=False)
    spec = await DataSourceSpec.get_one({"name": "lenient_provider"})
    spec.config = {"root": ConfigFieldSpec(required=True), "token": ConfigFieldSpec(required=True)}
    await spec.save(notify=False)
    src.config = {"root": "/tmp/x"}
    await src.save(notify=False)   # no `token`, and no raise
