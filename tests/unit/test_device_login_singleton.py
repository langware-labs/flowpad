"""One login per harness, and a login state that always resolves.

Regression cover for the observed failure: three live ``claude auth login``
processes at once, a pasted code accepted with ``{"submitted": true}`` that the
CLI never redeemed, and a UI stuck on "Waiting for you…" forever.

Root cause: ``_SESSIONS`` is per-process memory but the PTY child is not, so a
server restart (``flow start service`` runs on every workspace-ready) orphaned
the previous login while leaving it at its paste prompt. Each spawn mints its
own PKCE challenge, so a code from one session's URL is only redeemable by that
session — a second live login makes the paste-back a coin flip.
"""

import re
import subprocess
import sys

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginSpec,
    DeviceLoginState,
    WorkerAuthResult,
    WorkerAuthStatus,
)
from flow_sdk.builtin.agentic_process.cli_drivers.device_login import (
    _CODE_REJECTED_RE,
    DeviceLoginSession,
    _reap_stray_logins,
)


def _spawn_marker(tag: str) -> subprocess.Popen:
    """A long-lived process whose argv we can target, standing in for a login."""
    return subprocess.Popen([sys.executable, "-c", f"import threading;threading.Event().wait()  # {tag}"])


def test_reap_kills_every_stray_login_for_the_harness():
    """The singleton is enforced against the process table, not the registry."""
    argv = [sys.executable, "-c", "import threading;threading.Event().wait()  # strayA"]
    procs = [subprocess.Popen(argv) for _ in range(3)]
    try:
        assert all(p.poll() is None for p in procs), "fixture processes should be running"
        reaped = _reap_stray_logins(argv)
        assert reaped >= 3, f"expected to reap all 3 strays, reaped {reaped}"
        for process in procs:
            process.wait()
        assert all(p.poll() is not None for p in procs), "a stray login survived the reap"
    finally:
        for p in procs:
            if p.poll() is None:
                p.kill()


def test_reap_spares_the_pid_we_ask_it_to_keep():
    """A fresh spawn must not reap itself."""
    argv = [sys.executable, "-c", "import threading;threading.Event().wait()  # strayB"]
    keep = subprocess.Popen(argv)
    doomed = subprocess.Popen(argv)
    try:
        _reap_stray_logins(argv, keep_pid=keep.pid)
        doomed.wait()
        assert doomed.poll() is not None, "the stray should have been reaped"
        assert keep.poll() is None, "keep_pid must survive"
    finally:
        for p in (keep, doomed):
            if p.poll() is None:
                p.kill()


def test_reap_leaves_unrelated_processes_alone():
    """Matching is on the harness's own argv prefix, not a loose substring."""
    other = _spawn_marker("unrelated")
    try:
        _reap_stray_logins([sys.executable, "-c", "import threading;threading.Event().wait()  # somethingelse"])
        assert other.poll() is None, "reaped a process that was not this harness's login"
    finally:
        if other.poll() is None:
            other.kill()


def test_reap_is_a_noop_without_argv():
    assert _reap_stray_logins([]) == 0


async def test_start_spawns_a_real_pty_via_the_platform_pty_backend():
    """Regression for the observed Windows outage: ``start()`` unconditionally
    did ``from ptyprocess import PtyProcess`` to spawn the login PTY, but
    ptyprocess is Unix-only (needs ``fcntl``, which doesn't exist on
    Windows) — every login spawn failed instantly with
    ``ModuleNotFoundError: No module named 'ptyprocess'`` there. Windows
    ships ``pywinpty`` (the ``winpty`` module) instead.

    Deliberately spawns a REAL PTY through whichever backend ``device_login``
    picks for THIS platform rather than mocking it — a reintroduced
    unconditional import fails this test the exact same way it failed users.
    """
    spec = DeviceLoginSpec(
        login_argv=(sys.executable, "-c", "print('device-login-pty-test')"),
        url_re=re.compile(r"(https://\S+)"),
        code_re=None,
        accepts_code_paste=False,
    )

    async def probe_fn() -> WorkerAuthResult:
        # Anything other than LOGGED_IN/NOT_INSTALLED so start() proceeds to
        # the actual PTY spawn instead of short-circuiting before it.
        return WorkerAuthResult(status=WorkerAuthStatus.LOGGED_OUT)

    session = DeviceLoginSession(
        "device-login-pty-test",
        argv=[sys.executable, "-c", "print('device-login-pty-test')"],
        probe_fn=probe_fn,
        spec=spec,
    )
    try:
        await session.start()
        assert session.state != DeviceLoginState.ERROR, f"pty spawn failed: {session.message}"
        assert session._pty is not None, "start() never reached the PTY spawn"
    finally:
        session.cancel()


class _FakePty:
    """winpty.write() takes str, ptyprocess.write() takes bytes — mirror
    whichever ``device_login`` picks for this platform rather than assuming
    one, so this fixture doesn't silently mask the wrong choice."""

    def __init__(self, alive=True):
        self._alive = alive
        self.written = "" if sys.platform == "win32" else b""

    def isalive(self):
        return self._alive

    def write(self, data):
        self.written += data


def _session(state):
    """A session object with just enough shape to exercise submit_code."""
    from flow_sdk.builtin.agentic_process.cli_drivers.device_login import DeviceLoginSession

    s = DeviceLoginSession.__new__(DeviceLoginSession)
    s.state = state
    s._pty = _FakePty()
    s._code_submitted = False
    return s


def test_submit_code_refuses_unless_the_session_is_awaiting_the_user():
    """The old guard was "PTY alive", which is true for a session that has
    already errored or authenticated — so the write went nowhere and the caller
    was told it had succeeded."""
    for state in (
        DeviceLoginState.IDLE,
        DeviceLoginState.STARTING,
        DeviceLoginState.AUTHENTICATED,
        DeviceLoginState.ERROR,
    ):
        s = _session(state)
        assert s.submit_code("abc") is False, f"accepted a code while {state}"
        assert not s._pty.written, "nothing may be written to a session not awaiting a code"


def test_submit_code_writes_when_awaiting_and_marks_it():
    s = _session(DeviceLoginState.AWAITING_USER)
    assert s.submit_code(" abc123 ") is True
    expected = "abc123\r" if sys.platform == "win32" else b"abc123\r"
    assert s._pty.written == expected
    assert s._code_submitted is True


def test_submit_code_refuses_a_dead_pty():
    s = _session(DeviceLoginState.AWAITING_USER)
    s._pty = _FakePty(alive=False)
    assert s.submit_code("abc") is False


def test_rejection_pattern_matches_what_a_cli_says_about_a_bad_code():
    for line in (
        "Invalid code. Please try again.",
        "That code has expired",
        "Error: incorrect code provided",
        "the code was rejected",
        "Could not verify the code",
    ):
        assert _CODE_REJECTED_RE.search(line), f"should flag rejection: {line!r}"


def test_rejection_pattern_ignores_benign_output():
    """Narrow on purpose — a healthy session must not be tipped into ERROR."""
    for line in (
        "Opening browser to sign in…",
        "If the browser didn't open, visit: https://claude.com/cai/oauth/authorize?code=true",
        "Paste code here if prompted > ",
        "error opening browser",
        "Store token in plaintext config file? (y/N)",
    ):
        assert not _CODE_REJECTED_RE.search(line), f"false positive on: {line!r}"
