from types import SimpleNamespace

from flow_sdk.cli.commands import compute_cmd
from flow_sdk.compute.providers.docker.worker import _signal_connected


def _result(returncode=0, stdout="", stderr=""):
    return SimpleNamespace(returncode=returncode, stdout=stdout, stderr=stderr)


def test_worker_supervisor_delegates_readiness_to_handshake_event():
    script = compute_cmd._worker_supervisor_script()

    assert "/opt/flow/bin/flow compute worker" in script
    assert 'FLOW_WORKER_READY_PATH="$ready_fifo"' in script
    assert 'FLOW_WORKER_CONNECTED_PATH="$connected_file"' in script
    assert 'if [ ! -f "$connected_file" ]' in script
    assert "sleep " not in script


def test_worker_prepare_retires_exact_legacy_worker_commands():
    script = compute_cmd._worker_prepare_script()

    assert "/proc/[0-9]*" in script
    assert 'if [ "$old_pid" = "$$" ]' in script
    assert "*'/opt/flow/bin/flow compute worker'*" in script
    assert "pkill" not in script
    assert "/tmp/flowpad-worker-output" in script


def test_worker_handshake_signal_writes_connected_then_ready(tmp_path):
    connected = tmp_path / "connected"
    ready = tmp_path / "ready"

    _signal_connected(str(ready), str(connected))

    assert connected.read_text(encoding="utf-8") == "connected\n"
    assert ready.read_text(encoding="utf-8") == "ready\n"


def test_start_worker_waits_on_registration_fifo(monkeypatch):
    calls = []
    results = iter(
        [
            _result(),
            _result(),
            _result(stdout="ready\n"),
        ]
    )

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return next(results)

    monkeypatch.setattr(compute_cmd.subprocess, "run", fake_run)

    ready, detail = compute_cmd._start_worker_and_wait_until_connected(
        "/usr/bin/docker",
        "flowpad-e2e",
    )

    assert ready is True
    assert detail == ""
    assert calls[-1][0] == [
        "/usr/bin/docker",
        "exec",
        "flowpad-e2e",
        "cat",
        compute_cmd._WORKER_READY_FIFO,
    ]


def test_start_worker_reports_log_when_registration_fails(monkeypatch):
    results = iter(
        [
            _result(),
            _result(),
            _result(stdout="failed:1\n"),
            _result(stdout="handshake rejected\n"),
        ]
    )
    monkeypatch.setattr(
        compute_cmd.subprocess,
        "run",
        lambda *args, **kwargs: next(results),
    )

    ready, detail = compute_cmd._start_worker_and_wait_until_connected(
        "/usr/bin/docker",
        "flowpad-e2e",
    )

    assert ready is False
    assert detail == "handshake rejected"
