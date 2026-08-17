"""
Fixtures for CLI integration tests.

Extracted from the original tests/conftest.py:
- local_server: starts/stops the minihub server in a thread
- temp_workdir: temporary working directory
- claude_settings: temporary Claude settings directory
- client: synchronous httpx test client via ASGITransport
"""

import os
import time
import socket
from pathlib import Path

import pytest
import httpx


def is_port_in_use(port: int) -> bool:
    """Check if a port is already in use."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex(('127.0.0.1', port)) == 0


@pytest.fixture
def client(app):
    """Synchronous test client for FastAPI app using httpx with ASGI transport."""
    from httpx import ASGITransport
    transport = ASGITransport(app=app)
    return httpx.Client(transport=transport)


@pytest.fixture
def local_server(request):
    """Function-scoped fixture to start and stop the local test server."""
    import threading
    import requests
    from flow_sdk.server.app import start_server
    from flow_sdk.server.state import ping_results, prompt_completions

    port = getattr(request, 'param', {}).get('port', 9007) if hasattr(request, 'param') else 9007

    ping_results.clear()
    prompt_completions.clear()

    server_thread = threading.Thread(
        target=start_server,
        args=(port,),
        daemon=True
    )
    server_thread.start()
    time.sleep(1)

    class ServerHelper:
        def __init__(self, port):
            self.port = port
            self.base_url = f"http://127.0.0.1:{port}"

        def get_pings(self):
            response = requests.get(f"{self.base_url}/get_pings", timeout=5)
            if response.status_code == 200:
                return response.json()["pings"]
            return []

        def get_prompts(self):
            response = requests.get(f"{self.base_url}/get_prompts", timeout=5)
            if response.status_code == 200:
                return response.json()["prompts"]
            return []

    yield ServerHelper(port)


@pytest.fixture
def temp_workdir(tmp_path):
    """Function-scoped fixture that provides a temporary working directory."""
    yield tmp_path


@pytest.fixture
def claude_settings(temp_workdir, monkeypatch):
    """Function-scoped fixture that provides a temporary Claude settings directory."""
    import shutil

    original_cwd = Path.cwd()
    original_home = os.environ.get("HOME")

    if original_home:
        real_claude_dir = Path(original_home) / ".claude"
        claude_dir = temp_workdir / ".claude"
        claude_dir.mkdir(parents=True, exist_ok=True)

        if (real_claude_dir / ".claude.json").exists():
            shutil.copy(real_claude_dir / ".claude.json", claude_dir / ".claude.json")
        if (real_claude_dir / ".claude.json.backup").exists():
            shutil.copy(real_claude_dir / ".claude.json.backup", claude_dir / ".claude.json.backup")
    else:
        claude_dir = temp_workdir / ".claude"
        claude_dir.mkdir(parents=True, exist_ok=True)

    monkeypatch.setenv("HOME", str(temp_workdir))
    os.chdir(temp_workdir)

    settings_file = claude_dir / "settings.json"

    class SettingsHelper:
        def __init__(self, file_path, dir_path, home_path):
            self.file = file_path
            self.dir = dir_path
            self.home = home_path

    yield SettingsHelper(settings_file, claude_dir, temp_workdir)

    os.chdir(original_cwd)


# NOTE: ``sod_env`` fixture lives in tests/conftest.py so every test
# directory shares the same one. Don't redefine it here.


# ── instance-management fixtures ─────────────────────────────────────────────
# These back tests/cli/test_instance_*.py. Two properties matter:
#
#   1. They must be provably unable to touch the developer's real ``~/.flow``.
#      A test that silently ran against the real tree would both wreck a working
#      machine and make every "nothing was modified" assertion meaningless — the
#      snapshot would match because the writes landed somewhere else. So
#      ``instances_home`` asserts the redirection took effect before yielding.
#
#   2. They spawn REAL processes rather than mocking psutil. Ownership is
#      "what does this PID's environment say", which is only meaningfully
#      testable against a live process; a mocked process table would test the
#      mock. A sleeping child costs ~50ms, so the whole suite stays well inside
#      the unit budget.

@pytest.fixture
def instances_home(tmp_path, monkeypatch):
    """Redirect FLOW_HOME and the repo root at a tmp tree, and prove it took."""
    from flow_sdk.instances import paths

    flow_home = tmp_path / "flow"
    repo = tmp_path / "repo"
    (flow_home / "instances").mkdir(parents=True)
    repo.mkdir(parents=True)

    monkeypatch.setenv("FLOW_HOME", str(flow_home))
    monkeypatch.setattr(paths, "REPO_ROOT", repo)

    # Fail loudly if either redirection did not take: without this, a caching
    # or import-order regression turns every test below into a no-op that
    # quietly mutates the real machine.
    assert paths.instances_root() == flow_home / "instances"
    assert paths.instance_dir("probe") == flow_home / "instances" / "probe"
    assert paths.env_file("probe") == repo / ".env.probe.local"
    assert str(Path.home()) not in str(paths.instance_dir("probe"))

    class Home:
        def __init__(self):
            self.flow_home = flow_home
            self.repo = repo
            self.instances = flow_home / "instances"

        def snapshot(self) -> dict[str, tuple[int, str]]:
            """Content hash of every file under the tmp tree, for
            'this command touched nothing' assertions."""
            import hashlib

            out: dict[str, tuple[int, str]] = {}
            for root in (self.flow_home, self.repo):
                for p in sorted(root.rglob("*")):
                    if not p.is_file():
                        continue
                    data = p.read_bytes()
                    out[str(p.relative_to(tmp_path))] = (
                        len(data), hashlib.sha256(data).hexdigest()
                    )
            return out

    yield Home()


@pytest.fixture
def iname():
    """Unique instance names, so a test can never address a REAL instance.

    This is not tidiness — it is a safety boundary. ``FLOW_HOME`` redirects the
    on-disk state, but the process table is machine-global and cannot be
    redirected. A test that spawns a child called ``dev-2`` and then calls
    ``kill_owned("dev-2", scan())`` will terminate the developer's actual dev-2
    frontend, because from the predicate's point of view it genuinely is
    ``dev-2``. Prefixing every name with a per-test token removes the collision
    at the source.
    """
    import uuid

    token = uuid.uuid4().hex[:8]

    def make(base: str = "inst") -> str:
        return f"zz{token}-{base}"

    make.token = token
    return make


@pytest.fixture
def spawn_owned():
    """Spawn a real child carrying ``FLOW_INSTANCE=<instance>``.

    Optionally binds a listening socket. Readiness is a blocking read of the
    child's ``ready`` line — never a sleep or a poll, so the fixture adds no
    wait budget that could later drift into masking a real stall.

    Always pass a name from the ``iname`` fixture: see the warning there about
    the process table being machine-global.
    """
    import subprocess
    import sys

    procs: list[subprocess.Popen] = []

    def spawn(instance: str, port: int | None = None, env_instance: bool = True):
        src = ["import sys, time"]
        if port is not None:
            src += [
                "import socket",
                "s = socket.socket()",
                "s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)",
                f"s.bind(('127.0.0.1', {port}))",
                "s.listen(1)",
            ]
        src += [
            "sys.stdout.write('ready\\n')",
            "sys.stdout.flush()",
            "time.sleep(300)",
        ]
        env = dict(os.environ)
        env.pop("FLOW_INSTANCE", None)
        if env_instance:
            env["FLOW_INSTANCE"] = instance
        p = subprocess.Popen(
            [sys.executable, "-c", "\n".join(src)],
            env=env,
            stdout=subprocess.PIPE,
            text=True,
        )
        assert p.stdout is not None
        line = p.stdout.readline()
        assert line.strip() == "ready", f"child failed to start: {line!r}"
        procs.append(p)
        return p

    yield spawn

    for p in procs:
        p.kill()
        p.wait()


@pytest.fixture
def free_port():
    """Reserve an ephemeral port and release it, so a child can bind it."""
    def pick() -> int:
        with socket.socket() as s:
            s.bind(("127.0.0.1", 0))
            return s.getsockname()[1]

    return pick
