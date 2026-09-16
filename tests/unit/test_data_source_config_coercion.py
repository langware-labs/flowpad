"""``DataSource.save`` shapes ``config`` by the spec's field types — a URL sent
as a string where the manifest declares ``lines`` becomes a one-element list,
so the driver never iterates the characters of a URL."""
from __future__ import annotations

from typing import Annotated

import pytest
from pydantic import StringConstraints

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.schema.data_spec.data_driver_spec import FieldHints
from flow_sdk.sources.base import Source
from flow_sdk.sources.config import SourceConfig
from tests.unit._ingest_helpers import make_data_source

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]


async def test_lines_csv_and_number_fields_are_coerced_on_save():
    await DataDriver(
        name="probe_provider", title="Probe",
        config={"feed_urls": FieldHints(type="lines"), "tags": FieldHints(type="csv"), "depth": FieldHints(type="number")},
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
    await DataDriver(name="tree_provider", title="Tree", reflect=["none", "copy"]).save(notify=False)
    src = make_data_source(provider="tree_provider", config={"root": "/tmp/x"})
    assert src.reflect == "record"
    await src.save(notify=False)
    assert src.reflect == "none"

    chosen = make_data_source(provider="tree_provider", config={"root": "/tmp/y"}, reflect="copy")
    await chosen.save(notify=False)
    assert chosen.reflect == "copy", "a mode the spec offers is kept as given"


class _StrictConfig(SourceConfig):
    root: Annotated[str, StringConstraints(strip_whitespace=True, min_length=1)]
    note: str = ""


class _DefaultedConfig(SourceConfig):
    depth: int = 3


class _RegexConfig(SourceConfig):
    feed_urls: list[Annotated[str, StringConstraints(pattern=r"^https?://")]]


class _LenientConfig(SourceConfig):
    root: str = ""


def _driver(name: str, config: type[SourceConfig]) -> None:
    source = type(f"_{name}", (Source,), {"provider": name, "Config": config})
    DataDriver.register(DataDriver.for_class(source))


async def test_a_missing_required_field_refuses_the_create_naming_the_field():
    """The form already refuses it; this is the API's and an agent's copy of
    the rule — a `ValueError`, which the create route maps to a 400."""
    _driver("strict_provider", _StrictConfig)
    with pytest.raises(ValueError, match="config.root is required"):
        await make_data_source(provider="strict_provider", config={"note": "x"}).save(notify=False)
    with pytest.raises(ValueError, match="config.root is required"):
        await make_data_source(provider="strict_provider", config={"root": "   "}).save(notify=False)
    ok = make_data_source(provider="strict_provider", config={"root": "/tmp/x"})
    await ok.save(notify=False)
    assert ok.exist_in_db


async def test_a_field_with_a_default_may_be_omitted():
    _driver("defaulted_provider", _DefaultedConfig)
    src = make_data_source(provider="defaulted_provider", config={})
    await src.save(notify=False)
    assert src.exist_in_db


async def test_a_value_off_the_pattern_is_refused_per_entry_after_coercion():
    """`lines` are split first, so the message names the entry at fault, not
    the whole blob — the form's rule (`source-form.ts`), applied here."""
    _driver("regex_provider", _RegexConfig)
    with pytest.raises(ValueError, match=r"config.feed_urls is not valid: ftp://b/y"):
        await make_data_source(provider="regex_provider", config={"feed_urls": "http://a/x\nftp://b/y"}).save(notify=False)
    src = make_data_source(provider="regex_provider", config={"feed_urls": "http://a/x"})
    await src.save(notify=False)
    assert src.config["feed_urls"] == ["http://a/x"]


async def test_an_existing_row_is_not_re_validated_on_re_save(monkeypatch):
    """The poller re-saves every tick; a rule added to the Config after the row
    was minted must not turn that into an exception nobody reads."""
    _driver("lenient_provider", _LenientConfig)
    src = make_data_source(provider="lenient_provider", config={"root": "/tmp/x"})
    await src.save(notify=False)
    _driver("lenient_provider", _StrictConfig)  # a stricter rule, after the fact
    src.config = {"root": "/tmp/x"}
    await src.save(notify=False)   # no raise
