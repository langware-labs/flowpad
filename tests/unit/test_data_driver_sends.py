"""``DataDriver.sends`` is the driver's ``sends`` flag, put on the wire so a
client can tell a MessageSource from a plain source without a driver import.
It is computed, not stored: never authored in the manifest, never derived by
the indexer (which may not import the drivers package)."""
from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.fs_store.origin.local_origin import local_origin_for_path
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.data_driver_spec import DataDriverSpec
from flow_sdk.schema.types import EntityType

pytestmark = pytest.mark.timeout(5)


@pytest.mark.parametrize("provider", ["slack", "gmail", "rss", "agent"])
def test_sends_mirrors_the_driver(provider):
    driver = DataDriver.loaded(provider)
    assert driver is not None
    assert DataDriver(name=provider).sends is driver.sends


def test_a_provider_nothing_registered_does_not_send():
    assert DataDriver(name="no-such-provider").sends is False


def test_sends_reaches_the_wire_but_not_the_manifest(tmp_path):
    spec = DataDriver(name="slack", title="Slack")
    assert spec.model_dump(mode="json")["sends"] is True, "the API reads it"
    assert "sends" not in DataDriverSpec.model_fields, "never authored"

    ser = SchemaRegistry.get(EntityType.DATA_DRIVER).serializer()
    root = tmp_path / "slack"
    ser.store(spec, local_origin_for_path(root))
    doc = json.loads((root / "data_driver.json").read_text())
    assert "sends" not in doc, "a driver fact, not a file fact"
