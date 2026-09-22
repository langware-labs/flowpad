"""``VENDORS`` is the one vendor table — every consumer's vocabulary must agree with it."""

from __future__ import annotations

import sys
from pathlib import Path, PurePosixPath

import pytest

from flow_sdk.flowpad_types.vendors import (
    VENDOR_KEYS,
    VENDORS,
    default_vendor,
    vendor_by,
    vendor_for,
    vendor_for_path,
    vendor_or_none,
)


def test_the_five_vendors_and_every_spelling_resolve():
    assert VENDOR_KEYS == {"claude", "codex", "copilot", "opencode", "deepagents"}
    for v in VENDORS:
        for name in (v.key, v.worker_type, *v.aliases):
            assert vendor_for(name) is v
            assert vendor_for(name.upper()) is v
    assert vendor_for("claude_code_cli").key == "claude"
    assert vendor_or_none("cursor") is None
    with pytest.raises(ValueError):
        vendor_for("nope")


def test_worker_type_values_are_real_enum_members():
    from flow_sdk.flowpad_types.enums import WorkerType

    for v in VENDORS:
        assert WorkerType(v.worker_type).value == v.worker_type
        for alias in v.aliases:
            WorkerType(alias)  # every alias is a persisted spelling


def test_capability_kinds_and_harnesses_are_real():
    from flow_sdk.assets.placement import HarnessType
    from flow_sdk.core.capabilities.models import CapabilityKind

    kinds = {k.value for k in CapabilityKind}
    for v in VENDORS:
        assert v.capability_kind in kinds
        HarnessType(v.harness)
        assert vendor_by("capability_kind", v.capability_kind) is v


def test_worker_history_enum_is_the_vendor_key_vocabulary():
    from flow_sdk.builtin.worker_history import WorkerType as HistoryWorkerType

    assert {m.value for m in HistoryWorkerType} == VENDOR_KEYS


def test_default_vendor_reads_the_env_in_any_spelling(monkeypatch):
    monkeypatch.delenv("FLOWPAD_DEFAULT_WORKER", raising=False)
    assert default_vendor().key == "claude"
    monkeypatch.setenv("FLOWPAD_DEFAULT_WORKER", "CODEX")
    assert default_vendor().key == "codex"


@pytest.mark.parametrize(
    ("path", "expected"),
    [
        ("home/u/.claude/projects/x/abc.jsonl", "claude"),
        ("home/u/.codex/sessions/rollout.jsonl", "codex"),
        ("home/u/.copilot/session-state/events.jsonl", "copilot"),
        ("tmp/shadow/opencode_transcript_1.jsonl", "opencode"),
        ("tmp/shadow/session_ses_abc.jsonl", "opencode"),
        ("tmp/shadow/deepagents_transcript.jsonl", "deepagents"),
        ("tmp/shadow/other.jsonl", None),
    ],
)
def test_vendor_for_path(path, expected):
    vendor = vendor_for_path(PurePosixPath(path))
    assert (vendor.key if vendor else None) == expected


def test_consumers_agree_with_the_table():
    from flow_sdk.assets.placement import HarnessType, coerce_harness
    from flow_sdk.builtin.agent import driver_key, worker_type_value
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory, get_driver
    from flow_sdk.core.capabilities.registry import get_capability_registry, install_worker_type

    registry = get_capability_registry()
    for v in VENDORS:
        assert get_driver(v.worker_type).name == v.key
        # The executable IS the key for a binary on PATH; a ``python -m`` harness runs on this interpreter.
        expected_executable = Path(sys.executable).name if v.python_module else v.key
        assert factory({}, v.worker_type).EXECUTABLE == expected_executable
        assert driver_key(v.worker_type) == v.key and worker_type_value(v.key) == v.worker_type
        assert coerce_harness(v.worker_type) is HarnessType(v.harness)
        assert coerce_harness(v.capability_kind) is HarnessType(v.harness)
        assert registry.worker_type_for_kind(v.capability_kind) == v.worker_type
        assert install_worker_type(v.capability_kind) == v.worker_type


def test_declared_facts_single_out_the_builtin_worker():
    """``hidden`` / ``interactive`` / ``python_module`` are FACTS machinery asks, so the table is
    where they are pinned: exactly one vendor is the hidden, headless, package-shaped builtin."""
    assert [v.key for v in VENDORS if v.hidden] == ["deepagents"]
    assert [v.key for v in VENDORS if v.bootstrap] == ["deepagents"]
    assert [v.key for v in VENDORS if not v.interactive] == ["deepagents"]
    assert [v.key for v in VENDORS if v.python_module] == ["deepagents"]
    for v in VENDORS:
        # A python-module harness declares what makes it "installed"; nothing else may.
        assert bool(v.python_requires) == bool(v.python_module)
        # No dot-dir to sniff => the FlowPad-written transcript stems must be declared.
        assert v.dot_dir or v.transcript_stems
