"""Boot progress on real processes: a slow import keeps reporting, a hung import
goes silent and names itself, and a real server boot writes the whole timeline
into its log.

Wall-clock-bound by design (the reporter ticks once a second, and the third
test boots the backend), which is why the file lives here and not in
tests/unit. No timeout here is a budget to raise: the imports are scripted to
take a known number of seconds, and the boot is bounded by the same 30s the
other live-server fixtures use.
"""

from __future__ import annotations

import os
import re
import socket
import subprocess
import sys
import textwrap
import time
import urllib.request
import uuid
from pathlib import Path

BOOT_LINE = re.compile(
    r"^(?P<stamp>\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z) \[boot\] t=(?P<t>\d+\.\d)s "
    r"phase=(?P<phase>\S+) modules=(?P<modules>\d+) last=(?P<last>\S+)$"
)
STDLIB_LOG_LINE = re.compile(r"^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3} (INFO|WARNING|ERROR):")


def _boot_lines(text: str) -> list[re.Match]:
    return [m for m in (BOOT_LINE.match(line) for line in text.splitlines()) if m]


def _write_package(root: Path, name: str, modules: dict[str, str]) -> None:
    pkg = root / name
    pkg.mkdir()
    (pkg / "__init__.py").write_text(
        "".join(f"from . import {m}\n" for m in modules if m != "__init__") + modules.get("__init__", ""),
        encoding="utf-8",
    )
    for m, body in modules.items():
        if m != "__init__":
            (pkg / f"{m}.py").write_text(textwrap.dedent(body), encoding="utf-8")


def _run_reporting_import(tmp_path: Path, package: str) -> str:
    script = textwrap.dedent(
        f"""
        import sys
        from flow_sdk import boot_progress
        boot_progress.start(sys.stderr)
        import {package}
        boot_progress.stop()
        """
    )
    env = {**os.environ, "PYTHONPATH": str(tmp_path) + os.pathsep + os.environ.get("PYTHONPATH", "")}
    proc = subprocess.run([sys.executable, "-c", script], env=env, capture_output=True, text=True, timeout=60)
    assert proc.returncode == 0, proc.stderr
    return proc.stderr


def test_a_slow_import_phase_keeps_reporting_growth(tmp_path):
    """Forty modules at 0.1s each: the count in the log climbs every tick."""
    _write_package(tmp_path, "slowpkg", {f"m{i:02d}": "import time\ntime.sleep(0.1)\n" for i in range(40)})

    lines = _boot_lines(_run_reporting_import(tmp_path, "slowpkg"))

    assert len(lines) >= 4, [m.group(0) for m in lines]
    counts = [int(m["modules"]) for m in lines]
    assert counts == sorted(counts) and len(set(counts)) == len(counts), "every line is a strictly larger count"
    assert lines[0]["t"] == "0.0"
    assert lines[-1]["phase"] == "done"


def test_a_hung_import_goes_silent_and_the_last_line_names_it(tmp_path):
    """A module that blocks for 2.6s: the reporter writes one line when the
    module is entered (`last=` names it) and NOTHING while it blocks — the
    silence the watchdogs read as a stall is real, and the log says where."""
    _write_package(tmp_path, "hungpkg", {"blocker": "import time\ntime.sleep(2.6)\n"})

    lines = _boot_lines(_run_reporting_import(tmp_path, "hungpkg"))

    phases = [m["phase"] for m in lines]
    assert phases[0] == "import" and phases[-1] == "done"
    entered = [m for m in lines if m["last"] == "hungpkg.blocker" and m["phase"] == "import"]
    assert entered, [m.group(0) for m in lines]
    quiet = [m for m in lines if 1.5 < float(m["t"]) < 2.5]
    assert not quiet, "no line may be written while the import is blocked"


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def test_a_real_server_boot_writes_its_timeline_into_the_server_log(tmp_path):
    """The launcher's shape: stdout and stderr into one file, `-u`. The file
    then carries the boot phases in order, timestamped stdlib log lines, and
    the stdout report that used to be thrown away."""
    port = _free_port()
    env = {
        **os.environ,
        "FLOW_INSTANCE": f"boot-progress-{uuid.uuid4().hex[:8]}",
        "FLOW_HOME": str(tmp_path / "flow-home"),
        "LOCAL_SERVER_PORT": str(port),
        "MINIHUB_HOST": "127.0.0.1",
        "MINIHUB_RELOAD": "False",
        "FLOWPAD_SKIP_DOTENV": "true",
    }
    log = tmp_path / "server.log"
    with log.open("ab") as sink:
        proc = subprocess.Popen(
            [sys.executable, "-u", "-m", "flow_sdk.server.run"], env=env, stdout=sink, stderr=sink
        )
    try:
        deadline = time.monotonic() + 30.0
        healthy = False
        while time.monotonic() < deadline and proc.poll() is None:
            try:
                with urllib.request.urlopen(f"http://127.0.0.1:{port}/health/status", timeout=1) as resp:
                    healthy = resp.status == 200
                    break
            except OSError:
                time.sleep(0.2)
        assert healthy, f"backend never became healthy:\n{log.read_text(errors='replace')[-3000:]}"
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=3)

    text = log.read_text(encoding="utf-8", errors="replace")
    phases = [m["phase"] for m in _boot_lines(text)]
    assert phases[0] == "import"
    for expected in ("entities", "app", "uvicorn", "db", "startup_hooks", "done"):
        assert expected in phases, (expected, phases)
    assert phases.index("import") < phases.index("uvicorn") < phases.index("db") < phases.index("done")
    assert text.index("[boot]") < text.index("Started server process"), "progress reported before uvicorn's first line"
    assert "Total startup time (until Uvicorn starts)" in text, "stdout is in the server log"
    assert any(STDLIB_LOG_LINE.match(line) for line in text.splitlines()), "stdlib log lines carry timestamps"
