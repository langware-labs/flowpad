"""The agent transport's manifest declares every ``config`` key its driver
reads. The form is built from the manifest, so an undeclared key is one an
author can only set by hand and never see — six were missing when this was
written (deadline, send persona overrides, the legacy segment aliases)."""
from __future__ import annotations

import json
import re
from pathlib import Path

import flow_sdk
from flow_sdk.builtin.data_source_spec import ManifestSpec
from flow_sdk.ingest.drivers import agent as agent_driver

ROOT = Path(flow_sdk.__file__).parent
MANIFEST = ROOT / "system_projects/flowpad_assistant/agentic-assets/data_source/agent/data_source.json"


def test_every_key_the_driver_reads_is_declared():
    declared = set(json.loads(MANIFEST.read_text())["config"])
    read = set(re.findall(r"config\.get\(['\"](\w+)['\"]", Path(agent_driver.__file__).read_text()))
    assert read, "the driver reads config through config.get(...)"
    assert read <= declared, f"config keys the driver reads but the manifest does not declare: {sorted(read - declared)}"


def test_the_declared_defaults_are_the_drivers():
    spec = ManifestSpec.model_validate(json.loads(MANIFEST.read_text()))
    assert spec.config["deadline_seconds"].default == agent_driver.DEFAULT_DEADLINE_SECONDS
    assert spec.config["send_deadline_seconds"].default == agent_driver.DEFAULT_SEND_DEADLINE_SECONDS
    for key in ("deadline_seconds", "send_agent", "send_subagent", "send_deadline_seconds", "stream", "streams"):
        assert spec.config[key].advanced, f"{key} is an override, not the form's first screen"
