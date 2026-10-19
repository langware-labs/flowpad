"""scripts/instance_ctl.sh never hands out, or kills, a port another instance's registry records.

2026-10-01: two launches overlapped — qc-2 was still booting (registered :6006, not yet
listening) when qc-3 picked :6006 too, because the picker only asked "is anything listening".
`kill qc-3` then TERMed the listener on :6006 by its port fallback, which was qc-2's backend.
"""
from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "scripts" / "instance_ctl.sh"

pytestmark = pytest.mark.skipif(
    sys.platform == "win32" or shutil.which("bash") is None or shutil.which("lsof") is None,
    reason="instance_ctl.sh is a bash script that reads listeners with lsof",
)


def _register(flow_home: Path, name: str, **fields) -> None:
    d = flow_home / "instances" / name
    d.mkdir(parents=True)
    (d / "launcher.json").write_text(json.dumps({"name": name, **fields}, indent=2))


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _functions_then(flow_home: Path, snippet: str) -> str:
    """Run ``snippet`` with the script's functions loaded but ``main`` not called."""
    body = SCRIPT.read_text().rsplit('main "$@"', 1)[0]
    out = subprocess.run(
        ["bash", "-c", body + "\n" + snippet],
        env={**os.environ, "FLOW_HOME": str(flow_home)},
        capture_output=True,
        text=True,
        timeout=20,
    )
    assert out.returncode == 0, out.stderr
    return out.stdout.strip()


def test_a_port_a_booting_sibling_registered_is_not_handed_out(tmp_path):
    # qc-2 registered 6006 and is not listening yet; qc-3 prefers 6006.
    _register(tmp_path, "qc-2", backend_port=6006, frontend_port=5010)
    picked = _functions_then(tmp_path, "find_free_port 6000 6006 qc-3")
    assert picked != "6006"
    # Its OWN registry never blocks a relaunch onto the same port.
    assert _functions_then(tmp_path, "port_claimed_by_other 6006 qc-2 && echo claimed || echo free") == "free"


@pytest.mark.long  # ~1.1s: cmd_kill waits 1s between TERM and its port fallback
def test_killing_one_instance_spares_a_sibling_listening_on_a_port_it_also_recorded(tmp_path):
    port = _free_port()
    sibling = subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
    )
    try:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            with socket.socket() as s:
                if s.connect_ex(("127.0.0.1", port)) == 0:
                    break
            time.sleep(0.05)
        _register(tmp_path, "sibling", backend_port=port, backend_pid=sibling.pid)
        _register(tmp_path, "ghost", backend_port=port, backend_pid=999999)

        out = subprocess.run(
            ["bash", str(SCRIPT), "kill", "ghost", "--keep-env"],
            env={**os.environ, "FLOW_HOME": str(tmp_path)},
            capture_output=True,
            text=True,
            timeout=20,
        )
        assert out.returncode == 0, out.stderr
        assert sibling.poll() is None, "kill ghost took down the sibling listening on the shared port"
        assert "belongs to another instance" in out.stderr
    finally:
        sibling.terminate()
        sibling.wait(timeout=5)
