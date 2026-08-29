"""``VENDORS`` is the one vendor table — every consumer's vocabulary must agree with it."""

from __future__ import annotations

from pathlib import PurePosixPath

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


def test_the_four_vendors_and_every_spelling_resolve():
    assert VENDOR_KEYS == {"claude", "codex", "copilot", "opencode"}
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
    from flow_sdk.core.capabilities.models import CapabilityKind
    from flow_sdk.fs_store.placement import HarnessType

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
        ("tmp/shadow/other.jsonl", None),
    ],
)
def test_vendor_for_path(path, expected):
    vendor = vendor_for_path(PurePosixPath(path))
    assert (vendor.key if vendor else None) == expected


def test_consumers_agree_with_the_table():
    from flow_sdk.builtin.agent import driver_key, worker_type_value
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import factory, get_driver
    from flow_sdk.core.capabilities.registry import get_capability_registry, install_worker_type
    from flow_sdk.fs_store.placement import HarnessType, coerce_harness

    registry = get_capability_registry()
    for v in VENDORS:
        assert get_driver(v.worker_type).name == v.key
        assert factory({}, v.worker_type).EXECUTABLE == v.key  # alias-tolerant now; the executable IS the key
        assert driver_key(v.worker_type) == v.key and worker_type_value(v.key) == v.worker_type
        assert coerce_harness(v.worker_type) is HarnessType(v.harness)
        assert coerce_harness(v.capability_kind) is HarnessType(v.harness)
        assert registry.worker_type_for_kind(v.capability_kind) == v.worker_type
        assert install_worker_type(v.capability_kind) == v.worker_type
