import urllib.error
import urllib.request
from unittest.mock import patch

import pytest

from flow_sdk.server import launch
from flow_sdk.server.middleware.cookie_gate_middleware import HEADER_NAME


class StopMonitor(Exception):
    pass


# ---------------------------------------------------------------------------
# The health probe and the cookie gate
#
# The monitor probes the server it supervises. On a gated instance the gate has
# NO path exemptions -- `/health/status` included -- so a keyless probe is
# refused, a 403 is indistinguishable from a dead server, and the monitor kills
# a healthy app. The replacement is refused for the same reason: a restart loop
# with a doubling backoff that nothing recovers from.
# ---------------------------------------------------------------------------


class _Answer:
    """`urlopen` is used as a context manager and its body is never read."""

    def __enter__(self):
        return self

    def __exit__(self, *_exc):
        return False


def _headers(req):
    """Case-folded, because ``Request.add_header`` capitalizes what it is given
    and the assertion is about the header, not urllib's spelling of it."""
    return {name.lower(): value for name, value in req.header_items()}


def _probe(secret, response=None):
    """Run ``check_server_health`` against a stubbed urlopen, and return the
    Request it built so the caller can assert on its headers."""
    sent = {}

    def fake_urlopen(req, timeout=None):
        sent["req"] = req
        if response is not None:
            raise response
        return _Answer()

    with (
        patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", return_value=secret),
        patch.object(urllib.request, "urlopen", fake_urlopen),
    ):
        healthy = launch.check_server_health(9007)
    return healthy, sent.get("req")


def test_health_probe_carries_the_gate_secret_when_gated():
    """Without this header the monitor is refused by the instance it supervises."""
    healthy, req = _probe("s3cret-gate")

    assert healthy is True
    assert _headers(req).get(HEADER_NAME) == "s3cret-gate"


def test_health_probe_sends_no_gate_header_when_ungated():
    """Every desktop install. The probe must be byte-identical to what it was."""
    healthy, req = _probe(None)

    assert healthy is True
    assert HEADER_NAME not in _headers(req)


def test_health_probe_reports_a_refusal_as_unhealthy_without_raising():
    """A gated instance answering 403 is still "not serving me" -- reported, not
    raised, so the monitor keeps supervising."""
    refused = urllib.error.HTTPError("http://127.0.0.1:9007/health/status", 403, "Forbidden", {}, None)

    healthy, _ = _probe(None, response=refused)

    assert healthy is False


def test_health_probe_survives_an_unreadable_gate():
    """Being unable to read the secret is a reason to probe without it, never a
    reason to stop supervising."""
    with (
        patch("flow_sdk.instance_settings.cookie_gate.get_cookie_gate", side_effect=RuntimeError("sod is gone")),
        patch.object(urllib.request, "urlopen", lambda req, timeout=None: _Answer()),
    ):
        assert launch.check_server_health(9007) is True


def test_monitor_loop_does_not_restart_alive_server_before_failure_threshold(monkeypatch):
    sleep_calls = 0
    killed_pids: list[int] = []

    def fake_sleep(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 2:
            raise StopMonitor

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == []


def test_monitor_loop_restarts_alive_server_after_failure_threshold(monkeypatch):
    sleep_calls = 0
    killed_pids: list[int] = []
    saved_infos: list[dict] = []
    started_ports: list[int] = []

    def fake_sleep(_seconds: float) -> None:
        nonlocal sleep_calls
        sleep_calls += 1
        if sleep_calls > 4:
            raise StopMonitor

    def fake_start_server_process(port: int) -> int:
        started_ports.append(port)
        return 456

    monkeypatch.setattr(launch.time, "sleep", fake_sleep)
    monkeypatch.setattr(launch, "check_server_health", lambda _port: False)
    monkeypatch.setattr(launch, "_load_info", lambda: {"server_pid": 123})
    monkeypatch.setattr(launch, "_save_info", lambda info: saved_infos.append(info.copy()))
    monkeypatch.setattr(launch, "is_process_alive", lambda *_args, **_kwargs: True)
    monkeypatch.setattr(launch, "kill_process", lambda pid: killed_pids.append(pid))
    monkeypatch.setattr(launch, "start_server_process", fake_start_server_process)
    monkeypatch.setattr(launch, "wait_for_server_health", lambda *_args, **_kwargs: True)

    with pytest.raises(StopMonitor):
        launch.monitor_loop(9007, interval=0)

    assert killed_pids == [123]
    assert started_ports == [9007]
    assert saved_infos == [{"server_pid": 456}]
