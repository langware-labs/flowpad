"""Tests for the search-cloud-errors ComputeNode action."""

import asyncio
import json
import time
import unittest
from unittest.mock import AsyncMock, MagicMock, patch


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


# ─── Tests ───────────────────────────────────────────────────────────────────


class TestSearchCloudErrorsAction(unittest.IsolatedAsyncioTestCase):

    async def test_missing_fingerprints_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": []})

        with patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("fingerprints", resp.message)

    async def test_not_logged_in_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

        with (
            patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info),
            patch("flow_sdk.cli.auth.get_api_key", return_value=None),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("logged in", resp.message.lower())

    async def test_proxies_fingerprints_to_cloud(self):
        node = _make_compute_node()
        fp = "abc123def456"
        mock_info = _make_request_info({"fingerprints": [fp]})

        cloud_response = {"data": {"results": [{"fingerprint": fp, "action": "analyse", "instruction": None, "message": None}]}}
        captured = {}

        def _fake_urlopen(req, timeout):
            captured["url"] = req.full_url
            captured["body"] = json.loads(req.data)
            captured["auth"] = req.get_header("Authorization")
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.read.return_value = json.dumps(cloud_response).encode()
            return mock_resp

        with (
            patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info),
            patch("flow_sdk.cli.auth.get_api_key", return_value="test-api-key"),
            patch("urllib.request.urlopen", side_effect=_fake_urlopen),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "SUCCESS")
        self.assertIn("/analysis/search", captured["url"])
        self.assertEqual(captured["body"]["fingerprints"], [fp])
        self.assertEqual(captured["body"]["analysis_type"], "claude error")
        self.assertIn("test-api-key", captured["auth"])

    async def test_cloud_http_error_returns_fail(self):
        import urllib.error

        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

        with (
            patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info),
            patch("flow_sdk.cli.auth.get_api_key", return_value="test-api-key"),
            patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(
                url="http://test", code=401, msg="Unauthorized", hdrs={}, fp=None
            )),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")
        self.assertIn("401", resp.message)

    async def test_cloud_generic_error_returns_fail(self):
        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})

        with (
            patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info),
            patch("flow_sdk.cli.auth.get_api_key", return_value="test-api-key"),
            patch("urllib.request.urlopen", side_effect=ConnectionError("timeout")),
        ):
            resp = await node.search_cloud_errors_action()

        self.assertEqual(resp.status, "FAIL")

    async def test_cloud_call_does_not_block_event_loop(self):
        """
        The cloud HTTP call runs inside asyncio.to_thread so it must not block
        the event loop while waiting for the network response.

        Proof: a fast coroutine launched concurrently with the (slow) cloud
        search must finish before the cloud search does, and the total wall
        time must be close to slow_delay (not 2×slow_delay).
        """
        SLOW_DELAY = 0.25  # 250 ms simulated network latency

        node = _make_compute_node()
        mock_info = _make_request_info({"fingerprints": ["abc123def456"]})
        cloud_response = {
            "data": {
                "results": [
                    {"fingerprint": "abc123def456", "action": "analyse", "instruction": None, "message": None}
                ]
            }
        }

        def _slow_urlopen(req, timeout):
            time.sleep(SLOW_DELAY)  # blocks only the worker thread, not the event loop
            mock_resp = MagicMock()
            mock_resp.__enter__ = lambda s: s
            mock_resp.__exit__ = MagicMock(return_value=False)
            mock_resp.read.return_value = json.dumps(cloud_response).encode()
            return mock_resp

        fast_finished_at: list[float] = []

        async def _fast_coroutine():
            await asyncio.sleep(0)          # yield once to let the cloud call start
            fast_finished_at.append(time.monotonic())
            return "fast done"

        with (
            patch("flow_sdk.builtin.faas.compute_node.get_current_request_info", return_value=mock_info),
            patch("flow_sdk.cli.auth.get_api_key", return_value="test-api-key"),
            patch("urllib.request.urlopen", side_effect=_slow_urlopen),
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
