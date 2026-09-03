"""``DataSourceSpec.sends`` is the driver's ``sends`` flag, put on the wire so a
client can tell a MessageSource from a plain source without a driver import.
It is computed, not stored: never authored in the manifest, never derived by
the indexer (which may not import the drivers package)."""
from __future__ import annotations

import json

import pytest

import flow_sdk.ingest.drivers  # noqa: F401 — registers the shipped drivers
from flow_sdk.builtin.data_source_spec import DataSourceSpec, ManifestSpec
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.ingest.driver import get_driver
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


@pytest.mark.parametrize("provider", ["slack", "gmail", "rss", "agent"])
def test_sends_mirrors_the_driver(provider):
    driver = get_driver(provider)
    assert driver is not None
    assert DataSourceSpec(name=provider).sends is driver.sends


def test_a_provider_nothing_registered_does_not_send():
    assert DataSourceSpec(name="no-such-provider").sends is False


def test_sends_reaches_the_wire_but_not_the_manifest(tmp_path):
    spec = DataSourceSpec(name="slack", title="Slack")
    assert spec.model_dump(mode="json")["sends"] is True, "the API reads it"
    assert "sends" not in ManifestSpec.model_fields, "never authored"

    ser = SchemaRegistry.get(EntityType.DATA_SOURCE_SPEC).serializer()
    root = tmp_path / "slack"
    ser.store(spec, local_origin_for_path(root))
    doc = json.loads((root / "data_source.json").read_text())
    assert "sends" not in doc, "a driver fact, not a file fact"
