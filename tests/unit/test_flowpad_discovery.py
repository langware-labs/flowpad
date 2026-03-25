#!/usr/bin/env python3
"""Tests for flowpad_discovery module caching and rate-limiting."""

import time
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch

from flow_sdk.discovery.flowpad_discovery import (
    HOUR_IN_SECONDS,
    MAX_FAILURES_PER_HOUR,
    SERVER_JSON_PATH,
    FlowpadDiscoveryResult,
    FlowpadServerInfo,
    FlowpadStatus,
    _ServerState,
)


def make_server_info(port: int = 3000) -> FlowpadServerInfo:
    """Create a test server info object."""
    return FlowpadServerInfo(
        port=port,
        webhook_path="/api/v1/webhook/listen",
        health_path="/health",
        url=f"http://localhost:{port}/api/v1/webhook/listen",
    )


def make_running_result(port: int = 3000) -> FlowpadDiscoveryResult:
    """Create a result indicating server is running."""
    return FlowpadDiscoveryResult(
        status=FlowpadStatus.RUNNING,
        server_info=make_server_info(port),
    )


def make_not_running_result() -> FlowpadDiscoveryResult:
    """Create a result indicating server is not running."""
    return FlowpadDiscoveryResult(
        status=FlowpadStatus.INSTALLED_NOT_RUNNING,
        error="Server not responding",
    )


class TestServerStateCache(unittest.TestCase):
    """Tests for _ServerState caching behavior."""

    def setUp(self):
        self.state = _ServerState(SERVER_JSON_PATH)

    def test_cache_returns_same_result_when_port_file_unchanged(self):
        """Cache should return same result if port file hasn't changed."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_running_result()) as mock_discover:
            # First call - should discover
            result1 = self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 1)

            # Second call - should use cache
            result2 = self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 1)  # Still 1
            self.assertEqual(result1, result2)

    def test_cache_invalidates_when_port_file_changes(self):
        """Cache should invalidate when port file mtime changes."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_running_result()) as mock_discover:
            # First call
            self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 1)

            # Change port file mtime
            mock_stat.st_mtime = 2000.0

            # Second call - should re-discover
            self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 2)

    def test_cache_invalidates_when_rate_limited(self):
        """Cache should invalidate when rate limit is reached."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_not_running_result()) as mock_discover:
            # First call
            self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 1)

            # Record failures to reach rate limit
            for _ in range(MAX_FAILURES_PER_HOUR):
                self.state.record_webhook_failure()

            # Second call - should re-discover because rate limited
            self.state.get_discovery_result()
            self.assertEqual(mock_discover.call_count, 2)


class TestRateLimiting(unittest.TestCase):
    """Tests for rate limiting behavior."""

    def setUp(self):
        self.state = _ServerState(SERVER_JSON_PATH)

    def test_not_rate_limited_initially(self):
        """Should not be rate limited with no failures."""
        self.state._path = MagicMock()
        self.state._path.stat.side_effect = OSError("No file")
        self.assertFalse(self.state.is_rate_limited())

    def test_rate_limited_after_max_failures(self):
        """Should be rate limited after MAX_FAILURES_PER_HOUR failures."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        # Set mtime so it matches cached value
        self.state._port_file_mtime = 1000.0

        # Record failures
        for i in range(MAX_FAILURES_PER_HOUR):
            self.state.record_webhook_failure()
            if i < MAX_FAILURES_PER_HOUR - 1:
                self.assertFalse(self.state.is_rate_limited())

        # Now should be rate limited
        self.assertTrue(self.state.is_rate_limited())

    def test_rate_limit_expires_after_hour(self):
        """Rate limit should expire after an hour."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat
        self.state._port_file_mtime = 1000.0

        # Record failures with old timestamps
        old_time = time.time() - HOUR_IN_SECONDS - 1
        self.state._failure_timestamps = [old_time] * MAX_FAILURES_PER_HOUR

        # Should not be rate limited (failures are old)
        self.assertFalse(self.state.is_rate_limited())

    def test_rate_limit_clears_when_port_file_changes(self):
        """Rate limit should clear when port file changes."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat
        self.state._port_file_mtime = 1000.0

        # Record failures to reach rate limit
        for _ in range(MAX_FAILURES_PER_HOUR):
            self.state.record_webhook_failure()
        self.assertTrue(self.state.is_rate_limited())

        # Change port file mtime (server restarted)
        mock_stat.st_mtime = 2000.0

        # Should no longer be rate limited
        self.assertFalse(self.state.is_rate_limited())
        # Failures should be cleared
        self.assertEqual(len(self.state._failure_timestamps), 0)


class TestServerSimulation(unittest.TestCase):
    """Tests simulating server running/not running scenarios."""

    def setUp(self):
        self.state = _ServerState(SERVER_JSON_PATH)

    def test_server_running(self):
        """Simulate server is running."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_running_result()):
            result = self.state.get_discovery_result()

        self.assertEqual(result.status, FlowpadStatus.RUNNING)
        self.assertIsNotNone(result.server_info)
        self.assertEqual(result.server_info.port, 3000)

    def test_server_not_running(self):
        """Simulate server is not running."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_not_running_result()):
            result = self.state.get_discovery_result()

        self.assertEqual(result.status, FlowpadStatus.INSTALLED_NOT_RUNNING)
        self.assertIsNone(result.server_info)

    def test_server_wakes_up_after_rate_limit(self):
        """Simulate server waking up after rate limit was reached."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        with patch.object(self.state, "_discover", return_value=make_not_running_result()):
            result = self.state.get_discovery_result()
        self.assertEqual(result.status, FlowpadStatus.INSTALLED_NOT_RUNNING)

        # Record failures to reach rate limit
        for _ in range(MAX_FAILURES_PER_HOUR):
            self.state.record_webhook_failure()
        self.state._port_file_mtime = 1000.0  # Sync mtime
        self.assertTrue(self.state.is_rate_limited())

        # Server restarts - port file changes
        mock_stat.st_mtime = 2000.0

        # Rate limit should clear because port file changed
        self.assertFalse(self.state.is_rate_limited())

        # Get discovery result - should re-discover
        with patch.object(self.state, "_discover", return_value=make_running_result()):
            result = self.state.get_discovery_result()
        self.assertEqual(result.status, FlowpadStatus.RUNNING)
        self.assertIsNotNone(result.server_info)

        # Failures should be cleared
        self.assertEqual(len(self.state._failure_timestamps), 0)

    def test_failures_cleared_when_server_becomes_running(self):
        """Failures should clear when re-discovery finds server running."""
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        self.state._path = MagicMock()
        self.state._path.stat.return_value = mock_stat

        # Server not running, accumulate some failures (not enough to rate limit)
        with patch.object(self.state, "_discover", return_value=make_not_running_result()):
            self.state.get_discovery_result()
        self.state.record_webhook_failure()
        self.state.record_webhook_failure()
        self.assertEqual(len(self.state._failure_timestamps), 2)

        # Port file changes, server is now running
        mock_stat.st_mtime = 2000.0

        # Re-discover
        with patch.object(self.state, "_discover", return_value=make_running_result()):
            result = self.state.get_discovery_result()
        self.assertEqual(result.status, FlowpadStatus.RUNNING)

        # Failures should be cleared
        self.assertEqual(len(self.state._failure_timestamps), 0)


class TestIntegration(unittest.TestCase):
    """Integration tests for the full notification flow."""

    def test_full_cycle_server_down_then_up(self):
        """Test full cycle: server down, rate limit, server up, notifications resume."""
        state = _ServerState(SERVER_JSON_PATH)
        mock_stat = MagicMock()
        mock_stat.st_mtime = 1000.0
        state._path = MagicMock()
        state._path.stat.return_value = mock_stat

        # 1. Server is running initially
        with patch.object(state, "_discover", return_value=make_running_result()):
            result = state.get_discovery_result()
        self.assertEqual(result.status, FlowpadStatus.RUNNING)
        self.assertFalse(state.is_rate_limited())

        # 2. Server goes down (but port file unchanged - stale file)
        # Manually invalidate cache to simulate next check
        state._discovery_result = None

        # 3. Notifications start failing
        for _ in range(MAX_FAILURES_PER_HOUR):
            state.record_webhook_failure()

        state._port_file_mtime = 1000.0  # Sync mtime
        self.assertTrue(state.is_rate_limited())

        # 4. Server comes back up - port file updated
        mock_stat.st_mtime = 2000.0

        # 5. Rate limit should clear
        self.assertFalse(state.is_rate_limited())

        # 6. Discovery should find running server
        with patch.object(state, "_discover", return_value=make_running_result()):
            result = state.get_discovery_result()
        self.assertEqual(result.status, FlowpadStatus.RUNNING)
        self.assertEqual(len(state._failure_timestamps), 0)


if __name__ == "__main__":
    unittest.main()
