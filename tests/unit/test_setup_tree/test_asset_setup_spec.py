"""``asset_setup.json`` — the declared node: what a person writes is what the row and the walk read."""

from __future__ import annotations

import json

import pytest

from flow_sdk.builtin.asset_setup import AssetSetup
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec._kinds import register_builtin_kinds
from flow_sdk.schema.data_spec.asset_setup_spec import AssetSetupSpec, SetupTreeResult

pytestmark = pytest.mark.timeout(5)


def test_the_kinds_are_registered():
    register_builtin_kinds()
    assert SchemaRegistry.kind_type("asset.setup") is AssetSetupSpec
    assert SchemaRegistry.kind_type("setup.tree") is SetupTreeResult


def test_a_hand_written_document_reads_back_and_ignores_stray_keys(tmp_path):
    folder = tmp_path / "agentic-assets" / "asset_setup" / "waha"
    folder.mkdir(parents=True)
    (folder / "asset_setup.json").write_text(json.dumps({
        "name": "waha", "label": "WhatsApp (WAHA)", "children": ["asset_setup:waha-container"],
        "run": "waha-setup", "note": "a stray key a person left",
    }))

    spec = AssetSetup(name="waha", asset_ref=str(folder)).spec()

    assert spec == AssetSetupSpec(name="waha", label="WhatsApp (WAHA)", children=["asset_setup:waha-container"], run="waha-setup")


def test_a_broken_document_is_no_node_not_a_crash(tmp_path):
    folder = tmp_path / "asset_setup" / "bad"
    folder.mkdir(parents=True)
    (folder / "asset_setup.json").write_text("{ not json")
    assert AssetSetup(name="bad", asset_ref=str(folder)).spec() is None
