"""Unit test for the fix-all-cloud-errors ComputeNode bulk action.

Verifies the action shape and per-fingerprint spawn result without actually
running claude. AgenticProcess.save() and AgenticProcess.open() are patched
so no real LLM call is made.
"""

import tempfile
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

_PATCH_GET_CURRENT_REQUEST_INFO = "flow_sdk.builtin.faas.compute_node.get_current_request_info"


def _make_compute_node():
    from flow_sdk.builtin.faas.compute_node import ComputeNode
    return ComputeNode.__new__(ComputeNode)


def _make_request_info(body: dict):
    info = MagicMock()
    info.get_post_data = AsyncMock(return_value=body)
    info.someone_typeid = None
    return info


def _seed_error_with_fix(records_root: Path, fingerprint: str, instruction: str):
    """Write a ClaudeErrorRecord with a Fix instruction to disk."""
    from flow_sdk.fs_records.claude.claude_error import (
        ClaudeErrorRecord,
        ErrorStatus,
        Fix,
    )
    from flow_sdk.fs_store.resource_record_list import ResourceRecordList

    rec_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"claude_error:{fingerprint}"))
    backing = ResourceRecordList(
        list_path=records_root / "claude_error",
        record_class=ClaudeErrorRecord,
    )
    rec = ClaudeErrorRecord(
        id=rec_id,
        name=f"test-{fingerprint}",
        fingerprint=fingerprint,
        error_category="log",
        error_msg="boom",
        error_status=ErrorStatus.OPEN,
        occurrence_count=1,
        first_seen="2026-01-01T00:00:00Z",
        last_seen="2026-01-01T00:00:00Z",
        fix=Fix(instruction=instruction, message="cloud-saved fix"),
    )
    backing.create(rec)
    return rec_id


async def test_fix_all_cloud_errors_spawns_one_per_fingerprint():
    """Seed 1 fake ClaudeErrorRecord with a Fix; verify spawned[0]['status'] == 'spawned'."""
    from flow_sdk.fs_store.record import (
        get_default_records_root,
        set_default_records_root,
    )

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fp = "fix_all_test_fp_001"
            _seed_error_with_fix(tmp_dir, fp, "Run pip install foo")

            node = _make_compute_node()
            mock_info = _make_request_info({"fingerprints": [fp]})

            # Mock AgenticProcess so save() and open() don't actually run claude.
            mock_proc = MagicMock()
            mock_proc.save = AsyncMock(return_value=None)
            mock_proc.open = AsyncMock(return_value={"ok": True})
            mock_proc.shell_id = "shell-abc"
            mock_proc.worker_session_id = "ws-xyz"

            with (
                patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
                patch(
                    "flow_sdk.builtin.agentic_process.AgenticProcess",
                    return_value=mock_proc,
                ),
            ):
                resp = await node.fix_all_cloud_errors_action()

            assert resp.status == "SUCCESS"
            spawned = resp.data["spawned"]
            assert isinstance(spawned, list) and len(spawned) == 1
            assert spawned[0]["fingerprint"] == fp
            assert spawned[0]["status"] == "spawned"
            assert spawned[0]["shell_id"] == "shell-abc"
            assert spawned[0]["worker_session_id"] == "ws-xyz"
            mock_proc.open.assert_awaited_once()
            assert mock_proc.open.await_args.kwargs["instruction"] == "Run pip install foo"
        finally:
            set_default_records_root(original_root)


async def test_fix_all_cloud_errors_missing_fingerprints_fails():
    """Empty fingerprints list returns FAIL with helpful message."""
    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": []})

    with patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info):
        resp = await node.fix_all_cloud_errors_action()

    assert resp.status == "FAIL"
    assert "fingerprints" in resp.message


async def test_fix_all_cloud_errors_skips_when_no_fix_instruction():
    """Record without a Fix.instruction is skipped (no spawn)."""
    from flow_sdk.fs_records.claude.claude_error import (
        ClaudeErrorRecord,
        ErrorStatus,
    )
    from flow_sdk.fs_store.record import (
        get_default_records_root,
        set_default_records_root,
    )
    from flow_sdk.fs_store.resource_record_list import ResourceRecordList

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fp = "no_fix_fp"
            rec_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"claude_error:{fp}"))
            backing = ResourceRecordList(
                list_path=tmp_dir / "claude_error",
                record_class=ClaudeErrorRecord,
            )
            backing.create(
                ClaudeErrorRecord(
                    id=rec_id,
                    name="no-fix",
                    fingerprint=fp,
                    error_category="log",
                    error_msg="x",
                    error_status=ErrorStatus.OPEN,
                    occurrence_count=1,
                    first_seen="2026-01-01T00:00:00Z",
                    last_seen="2026-01-01T00:00:00Z",
                )
            )

            node = _make_compute_node()
            mock_info = _make_request_info({"fingerprints": [fp]})

            with patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info):
                resp = await node.fix_all_cloud_errors_action()

            assert resp.status == "SUCCESS"
            assert resp.data["spawned"] == [{"fingerprint": fp, "status": "skipped"}]
        finally:
            set_default_records_root(original_root)
