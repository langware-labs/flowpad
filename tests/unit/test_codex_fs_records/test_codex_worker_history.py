from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_records.worker_history import WorkerType, get_codex_worker_history


def test_codex_worker_history_shape(codex_sandbox: Path):
    entries = get_codex_worker_history(limit=5)

    assert entries
    entry = entries[0]
    assert entry.worker_type == WorkerType.CODEX
    assert entry.worker_id
    assert entry.project_cwd in {"/repo", "/Users/test/proj_b"}
    assert entry.project_name in {"repo", "proj_b"}
    assert entry.last_active_time.tzinfo is not None
    # Codex sessions don't carry a custom title — the prompt lives on last_prompt.
    assert entry.name is None
    assert entry.last_prompt == "Add a small helper function that prints hello."
    assert entry.message_count == 2
