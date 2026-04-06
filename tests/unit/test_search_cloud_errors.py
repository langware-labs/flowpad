"""Tests for the search-cloud-errors ComputeNode action."""

import asyncio
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

# Patch targets: imports inside search_cloud_errors_action are lazy (inside the function),
# so we patch at the source modules, not at compute_node module level.
_PATCH_GET_CURRENT_REQUEST_INFO = "flow_sdk.builtin.faas.compute_node.get_current_request_info"
_PATCH_GET_API_KEY = "flow_sdk.cli.auth.get_api_key"
_PATCH_FLOWPAD_CLIENT = "flow_sdk.client.FlowpadClient"


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


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestSearchCloudErrorsAction(unittest.IsolatedAsyncioTestCase):

    async def test_missing_fingerprints_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": []})

        with patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("fingerprints", resp.message)

    async def test_not_logged_in_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

        with (
            patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
            patch(_PATCH_GET_API_KEY, return_value=None),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("logged in", resp.message.lower())

    async def test_proxies_fingerprints_to_cloud(self):
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

        self.assertEqual(resp.status, "SUCCESS")
        self.assertIn("/analysis/search", captured["path"])
        self.assertEqual(captured["body"]["fingerprints"], [fp])
        self.assertEqual(captured["body"]["analysis_type"], "claude error")
        mock_client.set_api_key.assert_called_once_with("test-api-key")

    async def test_cloud_http_error_returns_fail(self):
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

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("401", resp.message)

    async def test_cloud_generic_error_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

        mock_client = _make_mock_client(post_side_effect=ConnectionError("timeout"))

        with (
            patch(_PATCH_GET_CURRENT_REQUEST_INFO, return_value=mock_info),
            patch(_PATCH_GET_API_KEY, return_value="test-api-key"),
            patch(_PATCH_FLOWPAD_CLIENT, return_value=mock_client),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")

    async def test_cloud_call_does_not_block_event_loop(self):
        """
        The cloud HTTP call is truly async via FlowpadClient, so it must not
        block the event loop while waiting for the network response.

        Proof: a fast coroutine launched concurrently with the (slow) cloud
        search must finish before the cloud search does, and the total wall
        time must be close to slow_delay (not 2×slow_delay).
        """
        SLOW_DELAY = 0.25  # 250 ms simulated network latency

        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})
        expected_result = {"results": [{"fingerprint": "abc123def456", "action": "analyse", "instruction": None, "message": None}]}

        async def _slow_post(path, data):
            await asyncio.sleep(SLOW_DELAY)  # async sleep, yields to event loop
            return expected_result

        mock_client = MagicMock()
        mock_client.set_api_key = MagicMock()
        mock_client.post = _slow_post
        mock_client.__aenter__ = AsyncMock(return_value=mock_client)
        mock_client.__aexit__ = AsyncMock(return_value=False)

        fast_finished_at: list[float] = []

        async def _fast_coroutine():
            await asyncio.sleep(0)          # yield once to let the cloud call start
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

        # Cloud call succeeded
        self.assertEqual(cloud_resp.status, "SUCCESS")
        # Fast coroutine also completed
        self.assertEqual(fast_result, "fast done")
        # The fast coroutine finished well before the cloud delay expired
        self.assertLess(fast_finished_at[0] - start, SLOW_DELAY * 0.9)
        # Total wall time is bounded by the cloud delay, not doubled
        self.assertLess(elapsed, SLOW_DELAY + 0.5)


if __name__ == "__main__":
    unittest.main()
