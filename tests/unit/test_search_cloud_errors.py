"""Tests for the search-cloud-errors ComputeNode action.

Covers both the cloud proxy layer (auth, HTTP errors, async behaviour) and
the _apply_cloud_results side-effect that persists fix / ignore decisions
to on-disk ClaudeErrorRecord files.
"""

import asyncio
import time
import uuid
from pathlib import Path
from unittest.mock import AsyncMock, MagicMock, patch

import pytest

# Patch targets: imports inside search_cloud_errors_action are lazy (inside the function),
# so we patch at the source modules, not at compute_node module level.
_PATCH_GET_CURRENT_REQUEST_INFO = "flow_sdk.builtin.faas.compute_node.get_current_request_info"
_PATCH_GET_API_KEY = "flow_sdk.cli.auth.get_api_key"
_PATCH_FLOWPAD_CLIENT = "flow_sdk.client.FlowpadClient"
_PATCH_GET_RECORDS_ROOT = "flow_sdk.fs_store.record.get_default_records_root"


# ─── Helpers ─────────────────────────────────────────────────────────────────


def _make_compute_node():
    """Return a minimal ComputeNode-like mock with the action method."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode

    node = ComputeNode.__new__(ComputeNode)
    return node


def _make_request_info(body: dict):
    """Return a mock request_info that yields `body` from get_post_data."""
    info = MagicMock()
    info.get_post_data = AsyncMock(return_value=body)
    return info


def _make_mock_client(post_result=None, post_side_effect=None):
    """Return an async context manager mock for FlowpadClient."""
    mock_client = MagicMock()
    mock_client.set_api_key = MagicMock()
    if post_side_effect is not None:
        mock_client.post = AsyncMock(side_effect=post_side_effect)
    else:
        mock_client.post = AsyncMock(return_value=post_result)
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)
    return mock_client


# ─── Tests: cloud proxy layer ────────────────────────────────────────────────


async def test_missing_fingerprints_returns_fail():
    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": []})

    with patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "FAIL"
    assert "fingerprints" in resp.message


async def test_not_logged_in_returns_fail():
    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value=None),
    ):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "FAIL"
    assert "logged in" in resp.message.lower()


async def test_proxies_fingerprints_to_cloud():
    node = _make_compute_node()
    fp = "abc123def456"
    mock_info = _make_request_info({"fingerprints": [fp]})

    expected_result = {"results": [{"fingerprint": fp, "action": "analyse", "instruction": None, "message": None}]}
    captured = {}

    async def _fake_post(path, data):
        captured["path"] = path
        captured["body"] = data
        return expected_result

    mock_client = MagicMock()
    mock_client.set_api_key = MagicMock()
    mock_client.post = _fake_post
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value="test-api-key"),
        patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
    ):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "SUCCESS"
    assert "/analysis/search" in captured["path"]
    assert captured["body"]["fingerprints"] == [fp]
    assert captured["body"]["analysis_type"] == "claude_error"
    mock_client.set_api_key.assert_called_once_with("test-api-key")


async def test_cloud_http_error_returns_fail():
    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

    mock_client = _make_mock_client(
        post_side_effect=ValueError("API returned status 401: Unauthorized")
    )

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value="test-api-key"),
        patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
    ):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "FAIL"
    assert "401" in resp.message


async def test_cloud_generic_error_returns_fail():
    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

    mock_client = _make_mock_client(post_side_effect=ConnectionError("timeout"))

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value="test-api-key"),
        patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
    ):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "FAIL"


async def test_cloud_call_does_not_block_event_loop():
    """
    The cloud HTTP call is truly async via FlowpadClient, so it must not
    block the event loop while waiting for the network response.
    """
    SLOW_DELAY = 0.25  # 250 ms simulated network latency

    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": ["abc123def456"]})
    expected_result = {"results": [{"fingerprint": "abc123def456", "action": "analyse", "instruction": None, "message": None}]}

    async def _slow_post(path, data):
        await asyncio.sleep(SLOW_DELAY)
        return expected_result

    mock_client = MagicMock()
    mock_client.set_api_key = MagicMock()
    mock_client.post = _slow_post
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    fast_finished_at: list[float] = []

    async def _fast_coroutine():
        await asyncio.sleep(0)
        fast_finished_at.append(time.monotonic())
        return "fast done"

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value="test-api-key"),
        patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
    ):
        start = time.monotonic()
        cloud_resp, fast_result = await asyncio.gather(
            node.search_cloud_errors_action(),
            _fast_coroutine(),
        )
        elapsed = time.monotonic() - start

    assert cloud_resp.status == "SUCCESS"
    assert fast_result == "fast done"
    assert fast_finished_at[0] - start < SLOW_DELAY * 0.9
    assert elapsed < SLOW_DELAY + 0.5


# ─── _apply_cloud_results integration tests ─────────────────────────────────


def _create_error_record(records_root: Path, fingerprint: str):
    """Write a minimal ClaudeErrorRecord to disk and return the record id."""
    from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord, ErrorStatus
    from flow_sdk.fs_store.resource_record_list import ResourceRecordList

    rec_id = str(uuid.uuid5(uuid.NAMESPACE_DNS, f"claude_error:{fingerprint}"))
    backing = ResourceRecordList(list_path=records_root / "claude_error", record_class=ClaudeErrorRecord)
    rec = ClaudeErrorRecord(
        id=rec_id,
        name=f"test-{fingerprint}",
        fingerprint=fingerprint,
        error_category="log",
        error_msg="test error",
        error_status=ErrorStatus.OPEN,
        occurrence_count=1,
        first_seen="2026-01-01T00:00:00Z",
        last_seen="2026-01-01T00:00:00Z",
    )
    backing.create(rec)
    return rec_id, backing


def _reload_record(backing, rec_id):
    """Reload a record from disk via get (reads metadata.json)."""
    from flow_sdk.fs_records.claude.claude_error import ClaudeErrorRecord
    rec = ClaudeErrorRecord.get(rec_id)
    assert rec is not None, f"Record {rec_id} not found after reload"
    return rec


async def _run_search_with_cloud_results(tmp_dir, fingerprints, cloud_results):
    """Helper: create records, run search action with mocked cloud, return rec_ids."""
    rec_ids = {}
    for fp in fingerprints:
        rec_id, _backing = _create_error_record(tmp_dir, fp)
        rec_ids[fp] = rec_id

    node = _make_compute_node()
    mock_info = _make_request_info({"fingerprints": fingerprints})

    async def _fake_post(path, data):
        return {"results": cloud_results}

    mock_client = MagicMock()
    mock_client.set_api_key = MagicMock()
    mock_client.post = _fake_post
    mock_client.__aenter__ = AsyncMock(return_value=mock_client)
    mock_client.__aexit__ = AsyncMock(return_value=False)

    with (
        patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
        patch(_PATCH_GET_API_KEY, return_value="test-key"),
        patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
    ):
        resp = await node.search_cloud_errors_action()

    assert resp.status == "SUCCESS"
    return rec_ids


async def test_fix_saves_instruction_and_triaged_at():
    """Cloud 'fix' result → record.fix.instruction, record.fix.message, record.triaged_at set."""
    import tempfile
    from flow_sdk.fs_records.claude.claude_error import Fix
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fp = "fix_test_fp_001"
            cloud_results = [{
                "fingerprint": fp,
                "action": "fix",
                "instruction": "Run migrations",
                "message": "Known schema drift",
            }]
            rec_ids = await _run_search_with_cloud_results(tmp_dir, [fp], cloud_results)

            rec = _reload_record(None, rec_ids[fp])
            assert isinstance(rec.fix, Fix)
            assert rec.fix.instruction == "Run migrations"
            assert rec.fix.message == "Known schema drift"
            assert rec.triaged_at, "triaged_at should be set"
            assert str(rec.error_status) == "open"  # fix doesn't change status
        finally:
            set_default_records_root(original_root)


async def test_ignore_marks_record_ignored():
    """Cloud 'ignore' result → record.error_status = IGNORED, triaged_at set."""
    import tempfile
    from flow_sdk.fs_records.claude.claude_error import ErrorStatus
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fp = "ignore_test_fp_001"
            cloud_results = [{
                "fingerprint": fp,
                "action": "ignore",
                "instruction": None,
                "message": None,
            }]
            rec_ids = await _run_search_with_cloud_results(tmp_dir, [fp], cloud_results)

            rec = _reload_record(None, rec_ids[fp])
            assert str(rec.error_status) == ErrorStatus.IGNORED
            assert rec.triaged_at, "triaged_at should be set"
        finally:
            set_default_records_root(original_root)


async def test_analyse_leaves_record_unchanged():
    """Cloud 'analyse' result → record is not modified."""
    import tempfile
    from flow_sdk.fs_records.claude.claude_error import ErrorStatus, Fix
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fp = "analyse_test_fp_001"
            cloud_results = [{
                "fingerprint": fp,
                "action": "analyse",
                "instruction": None,
                "message": None,
            }]
            rec_ids = await _run_search_with_cloud_results(tmp_dir, [fp], cloud_results)

            rec = _reload_record(None, rec_ids[fp])
            assert str(rec.error_status) == ErrorStatus.OPEN
            assert rec.triaged_at == ""
            assert isinstance(rec.fix, Fix)
            assert rec.fix.instruction == ""
        finally:
            set_default_records_root(original_root)


async def test_mixed_results_apply_correctly():
    """Multiple fingerprints with different actions are each handled correctly."""
    import tempfile
    from flow_sdk.fs_records.claude.claude_error import ErrorStatus, Fix
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            fps = ["mix_fix_fp", "mix_ignore_fp", "mix_analyse_fp"]
            cloud_results = [
                {"fingerprint": "mix_fix_fp", "action": "fix", "instruction": "Apply patch", "message": "Patch available"},
                {"fingerprint": "mix_ignore_fp", "action": "ignore", "instruction": None, "message": None},
                {"fingerprint": "mix_analyse_fp", "action": "analyse", "instruction": None, "message": None},
            ]
            rec_ids = await _run_search_with_cloud_results(tmp_dir, fps, cloud_results)

            rec_fix = _reload_record(None, rec_ids["mix_fix_fp"])
            assert rec_fix.fix.instruction == "Apply patch"
            assert rec_fix.fix.message == "Patch available"
            assert str(rec_fix.error_status) == ErrorStatus.OPEN
            assert rec_fix.triaged_at

            rec_ign = _reload_record(None, rec_ids["mix_ignore_fp"])
            assert str(rec_ign.error_status) == ErrorStatus.IGNORED
            assert rec_ign.triaged_at

            rec_ana = _reload_record(None, rec_ids["mix_analyse_fp"])
            assert str(rec_ana.error_status) == ErrorStatus.OPEN
            assert rec_ana.triaged_at == ""
            assert rec_ana.fix.instruction == ""
        finally:
            set_default_records_root(original_root)


async def test_unknown_fingerprint_is_silently_skipped():
    """Cloud result for a fingerprint not on disk is silently skipped."""
    import tempfile
    from flow_sdk.fs_store.record import set_default_records_root, get_default_records_root

    with tempfile.TemporaryDirectory() as tmp:
        tmp_dir = Path(tmp)
        original_root = get_default_records_root()
        set_default_records_root(tmp_dir)
        try:
            real_fp = "exists_fp"
            cloud_results = [
                {"fingerprint": "ghost_fp", "action": "fix", "instruction": "X", "message": "Y"},
                {"fingerprint": real_fp, "action": "fix", "instruction": "Real fix", "message": "Real msg"},
            ]
            rec_ids = await _run_search_with_cloud_results(tmp_dir, [real_fp], cloud_results)

            rec = _reload_record(None, rec_ids[real_fp])
            assert rec.fix.instruction == "Real fix"
        finally:
            set_default_records_root(original_root)
