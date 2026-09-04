"""Shared fixtures for unit tests that resolve Claude session transcripts."""
from __future__ import annotations

import asyncio
import json
import shlex
import subprocess
import sys
import time
import uuid
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.compute.providers.desktop.provider import LocalComputeProvider
from flow_sdk.flowpad_types import RuntimeEnvironment
from flow_sdk.fs_store.indexer.functions import claude_sessions as _claude_sessions
from flow_sdk.fs_store.record_paths import (
    get_default_records_data_root,
    get_default_records_root,
    set_default_records_data_root,
    set_default_records_root,
)

CLAUDE_SID = "11111111-1111-4111-8111-111111111111"


# ---------------------------------------------------------------------------
# Shared git fixtures
# ---------------------------------------------------------------------------
#
# ~20 test files grew their own copy of these two helpers. New git tests use
# these; the existing copies are left alone rather than churned. They are here
# because the setup carries two non-obvious requirements a copy gets wrong:
#
#   * ``tests/conftest.py`` sandboxes HOME, so ``~/.gitconfig`` is invisible:
#     ``user.name``/``user.email`` MUST be set per repo or every commit fails.
#   * ``init.defaultBranch`` is likewise unset, so ``-b main`` MUST be explicit
#     or a machine defaulting to ``master`` silently breaks the fixture.


def git_cmd(path: Path, *args: str) -> str:
    """Run git in ``path`` and return trimmed stdout; raises on failure."""
    result = subprocess.run(["git", *args], cwd=path, capture_output=True, text=True, check=True)
    return result.stdout.strip()


@pytest.fixture
def git_remote(tmp_path: Path):
    """A bare repo plus a factory for checkouts wired to it.

    ``make_checkout()`` returns a working clone whose ``origin`` is the bare
    repo. Pass ``github_url=...`` to additionally install an ``insteadOf``
    rewrite, so code that insists on a canonical GitHub remote (the publish
    path) can be exercised without touching the network.
    """
    remote = tmp_path / "remote.git"
    remote.mkdir()
    git_cmd(remote, "init", "--bare", "-q", "-b", "main")

    def make_checkout(name: str = "repo", *, github_url: str | None = None, seed: bool = True) -> Path:
        repo = tmp_path / name
        repo.mkdir()
        git_cmd(repo, "init", "-q", "-b", "main")
        git_cmd(repo, "config", "user.name", "Test User")
        git_cmd(repo, "config", "user.email", "test@example.com")
        origin = github_url or remote.as_uri()
        if github_url:
            git_cmd(repo, "config", f"url.{remote.as_uri()}.insteadOf", github_url)
        git_cmd(repo, "remote", "add", "origin", origin)
        if seed:
            (repo / "README.md").write_text("seed\n", encoding="utf-8")
            git_cmd(repo, "add", ".")
            git_cmd(repo, "commit", "-q", "-m", "initial")
            git_cmd(repo, "push", "-q", "-u", "origin", "main")
        return repo

    return SimpleNamespace(path=remote, uri=remote.as_uri(), make_checkout=make_checkout)


# ---------------------------------------------------------------------------
# Shared LocalComputeProvider helpers (compute streaming + env tests)
# ---------------------------------------------------------------------------


@pytest.fixture
async def node():
    """A started local compute node; yields ``(provider, node_id)``."""
    provider = LocalComputeProvider()
    node_id = await provider.create_node("unit-test-node", RuntimeEnvironment(name="unit-test"))
    await provider.startup(node_id)
    try:
        yield provider, node_id
    finally:
        await provider.shutdown(node_id)


@pytest.fixture(params=["local", "e2b"])
def compute_provider_kind(request):
    """Parameterizes a test across both providers we ship a node for.

    Mirrors the hub's ``test_compute_provider_type`` fixture, minus the
    credentials: the hub boots a real E2B sandbox, which we cannot do in the
    unit tier.
    """
    return request.param


@pytest.fixture
async def any_provider(compute_provider_kind):
    """``(provider, node_id)`` for the local provider AND for E2B.

    The E2B leg is a real ``E2BComputeProvider`` with one seam replaced —
    ``_get_or_boot_sandbox`` returns a :class:`FakeSandbox` instead of calling
    the E2B API. Everything the provider does with the command (prefix
    construction, quoting, ``background``, ``CLICommand`` wiring) still runs.
    What is NOT covered here: sandbox boot, pause/resume, PTY, and filesystem
    ops — those live in ``tests/long_tests`` behind the ``E2B_KEY`` gate.

    ``provider.fake_sandbox`` is attached so a test can inspect the exact
    command string that reached the shell.
    """
    if compute_provider_kind == "local":
        provider = LocalComputeProvider()
        node_id = await provider.create_node("unit-test-node", RuntimeEnvironment(name="unit-test"))
        await provider.startup(node_id)
        try:
            yield provider, node_id
        finally:
            await provider.shutdown(node_id)
        return

    from flow_sdk.compute.providers.e2b import provider as e2b_module
    from tests.unit.fakes.fake_e2b_sandbox import FakeSandbox

    # The provider's __init__ refuses to construct without the e2b SDK. The
    # module imports fine without it (AsyncSandbox is None), so bypass only
    # that guard — the class under test is otherwise untouched.
    provider = object.__new__(e2b_module.E2BComputeProvider)
    ComputeProviderBase = type(provider).__mro__[1]
    ComputeProviderBase.__init__(provider)
    provider._sandboxes = {}
    provider._pty_processes = {}
    provider._keepalive_tasks = {}

    sandbox = FakeSandbox()
    provider.fake_sandbox = sandbox

    async def _fake_boot(_provider_node_id):
        return sandbox

    provider._get_or_boot_sandbox = _fake_boot
    yield provider, "fake-sandbox"


def py_command(script: str, *, unbuffered: bool = False) -> str:
    """A shell command that runs ``script`` under this interpreter. Pass
    ``unbuffered=True`` for line-timely streaming (``python -u``)."""
    flag = " -u" if unbuffered else ""
    return f"{shlex.quote(sys.executable)}{flag} -c {shlex.quote(script)}"


# ---------------------------------------------------------------------------
# Shared Shell/PTY helpers (used by test_shell_proc_interface + test_shell_io_worker)
# ---------------------------------------------------------------------------


def make_shell(**kwargs) -> Shell:
    """A Shell with random id + compute_node_id (no DB, no server)."""
    return Shell(id=str(uuid.uuid4()), compute_node_id=str(uuid.uuid4()), **kwargs)


async def poll_read(shell: Shell, keyword: bytes, timeout: float = 10.0) -> bytes:
    """Poll ``shell.read()`` until *keyword* appears, or raise on timeout."""
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        out = await shell.read()
        if keyword in out:
            return out
        await asyncio.sleep(0.1)
    out = await shell.read()
    raise TimeoutError(f"{keyword!r} not found within {timeout}s. last output: {out[-200:]!r}")


async def kill_pty(shell: Shell) -> None:
    """Tear down a shell's live PTY, if any."""
    pty = shell.compute_node.get_pty(shell.id) if shell.compute_node_id else None
    if pty:
        await pty.kill()


@pytest.fixture
def tmp_records_root(tmp_path, monkeypatch):
    """Redirect the records root at every binding site. NON-autouse: files that
    want it opt in with a module-level ``autouse`` wrapper (so it does not apply
    to unrelated unit tests).

    ``set_default_records_data_root`` rebinds only the lambda inside
    ``flow_sdk.fs_store.record``; modules that did ``from … import
    get_default_records_data_root`` keep their own binding, so patch those too.
    """
    orig_root = get_default_records_root()
    orig_data_root = get_default_records_data_root()
    set_default_records_root(tmp_path)
    set_default_records_data_root(tmp_path)
    import flow_sdk.builtin.shell as _shell_mod
    monkeypatch.setattr(
        _shell_mod, "get_default_records_data_root", lambda: tmp_path,
        raising=False,
    )
    yield tmp_path
    set_default_records_root(orig_root)
    set_default_records_data_root(orig_data_root)


def write_claude_transcript(proj: Path, sid: str = CLAUDE_SID, *, n_lines: int = 1) -> Path:
    """Write a Claude JSONL transcript of ``n_lines`` user messages under ``proj``.

    ``n_lines=1`` is the cheap resolvable-session case; a large count produces a
    realistically-heavy transcript for parse-cost tests.
    """
    lines = [
        json.dumps({
            "parentUuid": None, "isSidechain": False, "type": "user",
            "message": {"role": "user", "content": "hello world " * 40 + f" line {i}"},
            "uuid": f"00000000-0000-4000-8000-{i:012d}",
            "timestamp": "2026-04-26T13:12:32.389Z", "cwd": "/repo",
            "sessionId": sid, "version": "2.1.119", "gitBranch": "main",
        })
        for i in range(n_lines)
    ]
    p = proj / f"{sid}.jsonl"
    p.write_text("\n".join(lines) + "\n", encoding="utf-8")
    return p


@pytest.fixture
def claude_projects(tmp_path, monkeypatch) -> Path:
    """A tmp ``claude_projects_dir`` (get_instance_settings patched); returns the project dir.

    Pair with :func:`write_claude_transcript` to drop a resolvable session under it.
    """
    proj = tmp_path / "-repo"
    proj.mkdir()
    monkeypatch.setattr(
        _claude_sessions, "get_instance_settings",
        lambda: SimpleNamespace(claude_projects_dir=tmp_path),
    )
    return proj


@pytest.fixture(autouse=True)
def _clean_activity_monitor():
    """Empty the activity monitor around every unit test.

    ``ActivityProgressMonitor`` is a process-global singleton, so an activity a test leaves
    running is visible to every test after it — and six activity test modules had each
    grown their own copy of this fixture, which is the point at which it stops being a
    coincidence. Clearing is a dict clear on an empty map for the tests that never touch
    it, so it costs nothing to make it the default.
    """
    from flow_sdk.activity import monitor

    monitor.clear()
    yield
    monitor.clear()
