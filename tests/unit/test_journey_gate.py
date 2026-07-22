"""Journey capability gate: graph.json `gate.requires_capabilities` semantics."""
from __future__ import annotations

import json

import pytest

import flow_sdk.core.capabilities as caps_mod
from flow_sdk.builtin.journey import Journey
from flow_sdk.fs_store.indexer.functions.journey import read_gate


def _journey_dir(tmp_path, gate=None):
    folder = tmp_path / "setup-x"
    folder.mkdir()
    doc = {
        "version": 1,
        "id": "5eaa7e57-1111-4222-8333-444455556666",
        "name": "x",
        "enabled": True,
        "nodes": [],
        "edges": [],
    }
    if gate is not None:
        doc["gate"] = gate
    (folder / "graph.json").write_text(json.dumps(doc), encoding="utf-8")
    return folder


def test_read_gate(tmp_path):
    gate = {"requires_capabilities": ["source_control.github"]}
    assert read_gate(_journey_dir(tmp_path, gate)) == gate
    assert read_gate(tmp_path / "missing") is None  # no graph.json → None


@pytest.mark.asyncio
async def test_gate_open_semantics(tmp_path, monkeypatch):
    states: dict[str, bool | None] = {}

    async def fake_check(kind):
        return states[kind]

    monkeypatch.setattr(caps_mod, "check_capability", fake_check)

    gate = {"requires_capabilities": ["a.b", "a.b.c"]}
    journey = Journey(asset_ref=str(_journey_dir(tmp_path, gate)))

    # all available → closed (nothing to set up)
    states.update({"a.b": True, "a.b.c": True})
    assert await journey.gate_open() is False

    # one unknown → open
    states.update({"a.b": True, "a.b.c": None})
    assert await journey.gate_open() is True

    # one definitively not available → open
    states.update({"a.b": False, "a.b.c": True})
    assert await journey.gate_open() is True


@pytest.mark.asyncio
async def test_no_gate_is_always_open(tmp_path):
    journey = Journey(asset_ref=str(_journey_dir(tmp_path)))
    assert await journey.gate_open() is True
    assert Journey(asset_ref="").gate() is None
