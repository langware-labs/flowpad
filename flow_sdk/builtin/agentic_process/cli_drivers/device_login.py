"""Generic device-login engine — runs one vendor CLI's login flow under a PTY.

One shared state machine for every harness; the vendor differences live
entirely in each driver's declared ``DeviceLoginSpec`` (argv, URL/code
regexes, paste-back flag). No orchestration code branches on vendor.

Flow: pre-probe (already logged in ⇒ short-circuit) → spawn the login CLI in
a PTY → scrape the OAuth URL (+ one-time code for device flows) from the
stream → surface them to the consumer via ``on_change`` → auto-answer known
interactive prompts (keychain) → optionally inject a user-pasted code
(claude) → on process exit re-run the auth probe (exit alone is never
trusted) → AUTHENTICATED / ERROR.

PTY handling mirrors the desktop compute provider: ``PtyProcess.spawn`` plus
a daemon read-thread; state-change callbacks are marshalled back onto the
event loop with ``call_soon_threadsafe``.
"""

from __future__ import annotations

import asyncio
import logging
import re
import sys
import threading
from functools import partial
from typing import Any, Awaitable, Callable

import psutil

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginSpec,
    DeviceLoginState,
    WorkerAuthResult,
    WorkerAuthStatus,
    clean_pty_output,
    find_auto_answer,
    scrape_device_login,
)
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    WorkerSpawnError,
    build_worker_spawn_env,
    get_driver,
    run_worker_auth_probe,
)
from flow_sdk.config import PLATFORM_WIN32

logger = logging.getLogger(__name__)

# Wide terminal so long OAuth URLs never soft-wrap mid-scrape (the scraper can
# rejoin wraps, but a generous width keeps the raw stream simple).
PTY_DIMENSIONS = (50, 1000)

# A login CLI that has printed its URL and is waiting at a paste prompt says
# nothing more, so a stale one is invisible until you look at the process table.
# Each spawn mints its OWN PKCE challenge, so a code obtained from one session's
# URL is only redeemable by that session: a second live login for the same
# harness makes the paste-back a coin flip. Hence exactly one, enforced.

# The CLI's own complaint about a code it would not redeem. Deliberately narrow:
# it must mention the code, so ordinary prose ("error opening browser") does not
# tip a healthy session into ERROR.
_CODE_REJECTED_RE = re.compile(
    r"(?i)(invalid|expired|incorrect|rejected|could not.{0,20}verify)[^\n]{0,40}\bcode\b"
    r"|\bcode\b[^\n]{0,40}(invalid|expired|incorrect|rejected)"
)


def _reap_stray_logins(argv: list[str], keep_pid: int | None = None) -> int:
    """Kill login processes for this harness that no session owns any more.

    ``_SESSIONS`` lives in this process's memory, but the PTY child does not:
    restart the server (``flow start service`` on every workspace-ready) and the
    registry is empty while the old ``claude auth login`` is still sitting at its
    paste prompt. The next login then spawns a SECOND one, and the user's pasted
    code goes to whichever the registry happens to hold — the observed
    "stuck on Waiting for you" with three live logins.

    So singleton-ness is enforced against the process table, which survives a
    restart, rather than against the dict, which does not. Returns the number
    reaped. Never raises: this is best-effort hygiene on the way to a spawn.
    """
    if not argv:
        return 0
    reaped = 0
    for proc in psutil.process_iter(["pid", "cmdline"]):
        try:
            cmdline = proc.info.get("cmdline") or []
            if list(cmdline[: len(argv)]) != argv:
                continue
            if keep_pid is not None and proc.info["pid"] == keep_pid:
                continue
            proc.kill()
            reaped += 1
        except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError):
            continue
    return reaped


class DeviceLoginSession:
    """One in-flight login flow for one worker type.

    ``argv``/``probe_fn`` are validation seams (e.g. running the CLI inside a
    docker container): they default to the driver spec's argv and the real
    host probe.
    """

    def __init__(
        self,
        worker_type: str,
        *,
        on_change: Callable[["DeviceLoginSession"], Awaitable[None]] | None = None,
        argv: list[str] | None = None,
        probe_fn: Callable[[], Awaitable[WorkerAuthResult]] | None = None,
        spec: DeviceLoginSpec | None = None,
    ) -> None:
        """``spec`` serves non-worker CLIs (e.g. gh): the login flow is spec-
        driven with no worker driver behind it, so the spec comes from the
        caller (a capability runner) and ``worker_type`` is just the session
        key. A spec-driven session requires ``probe_fn`` and resolves its own
        env (no worker spawn env exists for it)."""
        self.worker_type = worker_type
        self.spec: DeviceLoginSpec = spec or get_driver(worker_type).device_login_spec
        self._argv = argv or list(self.spec.login_argv)
        # Overridden argv or a caller-supplied spec resolves its own env.
        self._use_spawn_env = argv is None and spec is None
        self._probe = probe_fn or (lambda: run_worker_auth_probe(worker_type))
        self._on_change = on_change
        self._loop: asyncio.AbstractEventLoop | None = None
        self._pty: Any = None
        self._reader: threading.Thread | None = None
        self._answered: set[int] = set()
        self._cancelled = False
        self._code_submitted = False

        self.state = DeviceLoginState.IDLE
        self.url: str | None = None
        self.code: str | None = None
        self.message = ""
        self.raw = ""

    # ── Lifecycle ────────────────────────────────────────────────────────────

    async def start(self) -> None:
        self._loop = asyncio.get_running_loop()
        # start() runs synchronously under the action, which broadcasts the
        # resulting snapshot once after we return — so pre-spawn transitions set
        # state WITHOUT notifying (avoids a duplicate frame). Only reader-thread
        # transitions (after this returns) broadcast via on_change.
        self._set(DeviceLoginState.STARTING, notify=False)

        # Device may already be approved / creds still on disk — never mint a
        # fresh code when the CLI is already logged in.
        pre = await self._probe()
        if pre.status == WorkerAuthStatus.LOGGED_IN:
            self._set(DeviceLoginState.AUTHENTICATED, message=f"already authenticated — {pre.message}", notify=False)
            return
        if pre.status == WorkerAuthStatus.NOT_INSTALLED:
            self._set(DeviceLoginState.ERROR, message=pre.message, notify=False)
            return

        try:
            env = build_worker_spawn_env(self.worker_type, {}) if self._use_spawn_env else None
        except WorkerSpawnError as exc:
            self._set(DeviceLoginState.ERROR, message=str(exc), notify=False)
            return
        # Enforce one login per harness against the PROCESS TABLE before
        # spawning. The in-memory cancel in start_device_login only covers
        # sessions this process still remembers; anything orphaned by a restart
        # is invisible to it and would race us for the pasted code.
        reaped = await asyncio.to_thread(_reap_stray_logins, self._argv)
        if reaped:
            logger.info("device login: reaped %d stray %s login(s)", reaped, self.worker_type)

        try:
            # PTY handling mirrors the desktop compute provider: winpty on
            # Windows (Unix-only ptyprocess needs fcntl, which doesn't exist
            # there), ptyprocess elsewhere.
            if sys.platform == PLATFORM_WIN32:
                from winpty import PtyProcess  # noqa: PLC0415 — windows
            else:
                from ptyprocess import PtyProcess  # noqa: PLC0415 — unix

            self._pty = await asyncio.to_thread(PtyProcess.spawn, self._argv, env=env, dimensions=PTY_DIMENSIONS)
        except Exception as exc:
            self._set(DeviceLoginState.ERROR, message=f"failed to spawn login: {exc}", notify=False)
            return
        self._reader = threading.Thread(target=self._read_loop, daemon=True)
        self._reader.start()

    def submit_code(self, code: str) -> bool:
        """Inject a browser-shown code back into the login PTY (claude).

        Refuses unless this session is actually AWAITING_USER. "PTY is alive"
        was too weak a test: a session that has already errored, authenticated,
        or not yet printed its URL still has a live child, so the write silently
        went nowhere and the caller was told it had succeeded.
        """
        if self.state is not DeviceLoginState.AWAITING_USER:
            return False
        if self._pty is None or not self._pty.isalive():
            return False
        self._pty.write(self._encode_for_pty(code.strip() + "\r"))
        self._code_submitted = True
        return True

    def cancel(self) -> None:
        """Stop this login for good — and make sure the CLI actually died.

        ``terminate(force=True)`` is best-effort and ``isalive()`` can race the
        reader thread's own ``waitpid``, so a survivor here would sit at its
        paste prompt forever and compete with the next login for the code. The
        argv sweep is the backstop: it does not depend on this object's view of
        whether the child is alive.
        """
        self._cancelled = True
        pty = self._pty
        if pty is not None:
            try:
                if pty.isalive():
                    pty.terminate(force=True)
            except Exception:
                logger.debug("device login terminate failed", exc_info=True)
        # Backstop: whatever this object believes, leave no login of this shape
        # running. Cheap, and the only thing that holds across a server restart.
        try:
            _reap_stray_logins(self._argv)
        except Exception:
            logger.debug("device login reap-on-cancel failed", exc_info=True)

    def to_json(self) -> dict[str, Any]:
        return {
            "state": self.state.value,
            "url": self.url,
            "code": self.code,
            "message": self.message,
            "accepts_code_paste": self.spec.accepts_code_paste,
        }

    @staticmethod
    def _encode_for_pty(text: str) -> str | bytes:
        """winpty.write() expects str; ptyprocess.write() expects bytes."""
        return text if sys.platform == PLATFORM_WIN32 else text.encode()

    # ── Reader thread ────────────────────────────────────────────────────────

    def _read_loop(self) -> None:
        try:
            while True:
                try:
                    chunk = self._pty.read(1024)
                except EOFError:
                    break
                if not chunk:
                    break
                self.raw += chunk.decode("utf-8", "replace") if isinstance(chunk, bytes) else chunk
                self._scrape()
        except Exception:
            logger.debug("device login read loop error", exc_info=True)
        finally:
            self._finish()

    def _scrape(self) -> None:
        clean = clean_pty_output(self.raw)  # clean once; scrape + auto-answer share it
        url, code = scrape_device_login(clean, self.spec)
        changed = (url and not self.url) or (code and not self.code)
        self.url = self.url or url
        self.code = self.code or code
        answer = find_auto_answer(clean, self._answered)
        if answer is not None:
            self._answered.add(answer[0])
            self._pty.write(self._encode_for_pty(answer[1]))
        # A code the CLI rejects leaves it sitting at the SAME paste prompt, so
        # without this the session never leaves AWAITING_USER and the UI shows
        # "waiting for you" forever against a code that will never be accepted.
        if self._code_submitted and _CODE_REJECTED_RE.search(clean):
            self._code_submitted = False
            self._set_threadsafe(
                DeviceLoginState.ERROR,
                message="the pasted code was rejected — start the login again to get a fresh one",
            )
            return
        if self.url and self.state == DeviceLoginState.STARTING:
            self._set_threadsafe(DeviceLoginState.AWAITING_USER)
        elif changed:
            # New url/code arrived in a later chunk without a state change —
            # re-broadcast so the UI gets the code.
            self._notify_threadsafe()

    def _finish(self) -> None:
        """Login process exited — re-probe before declaring success."""
        if self._cancelled:
            self._set_threadsafe(DeviceLoginState.IDLE, message="login cancelled")
            return
        assert self._loop is not None
        result = asyncio.run_coroutine_threadsafe(self._probe(), self._loop).result(timeout=30)
        if result.status == WorkerAuthStatus.LOGGED_IN:
            self._set_threadsafe(DeviceLoginState.AUTHENTICATED, message=result.message)
        else:
            tail = clean_pty_output(self.raw).strip()[-300:]
            self._set_threadsafe(
                DeviceLoginState.ERROR,
                message=f"login exited but probe says {result.status.value}: {tail}",
            )

    # ── State + notification ────────────────────────────────────────────────

    def _set(self, state: DeviceLoginState, *, message: str = "", notify: bool = True) -> None:
        self.state = state
        if message:
            self.message = message
        if notify:
            self._emit_change()

    def _set_threadsafe(self, state: DeviceLoginState, *, message: str = "") -> None:
        assert self._loop is not None
        self._loop.call_soon_threadsafe(partial(self._set, state, message=message))

    def _notify_threadsafe(self) -> None:
        """Re-broadcast the current snapshot from the reader thread (no state
        change) — used when a fresh url/code lands in a later chunk."""
        assert self._loop is not None
        self._loop.call_soon_threadsafe(self._emit_change)

    def _emit_change(self) -> None:
        if self._on_change is None:
            return
        try:
            asyncio.ensure_future(self._on_change(self))
        except Exception:
            logger.warning("device login on_change failed", exc_info=True)


# ── Session registry (one live session per worker type) ─────────────────────

_SESSIONS: dict[str, DeviceLoginSession] = {}
_SESSIONS_LOCK = asyncio.Lock()


async def start_device_login(
    worker_type: str,
    *,
    on_change: Callable[[DeviceLoginSession], Awaitable[None]] | None = None,
    spec: DeviceLoginSpec | None = None,
    probe_fn: Callable[[], Awaitable[WorkerAuthResult]] | None = None,
) -> DeviceLoginSession:
    """Start (or replace) the login session for a worker type (or, with
    ``spec``+``probe_fn``, any spec-driven CLI keyed by that name)."""
    async with _SESSIONS_LOCK:
        old = _SESSIONS.get(worker_type)
        if old is not None:
            old.cancel()
        session = DeviceLoginSession(worker_type, on_change=on_change, spec=spec, probe_fn=probe_fn)
        _SESSIONS[worker_type] = session
    await session.start()
    return session


def get_device_login_session(worker_type: str) -> DeviceLoginSession | None:
    return _SESSIONS.get(worker_type)
