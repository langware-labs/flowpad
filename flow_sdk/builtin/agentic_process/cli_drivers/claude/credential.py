"""Keep the Claude CLI's OAuth credential usable across long idle gaps.

The CLI's access token lives 8 hours and is renewed only when a CLI process
starts and finds it expired — i.e. INSIDE whatever request happens to be first.
Flowpad spawns a fresh CLI process per turn, so the first turn after an idle gap
longer than the token's life carries that renewal on its own critical path. When
the renewal is quick (measured: ~1s) nobody notices. When it is not, the CLI
stops waiting, sends the turn with the token it already knows is dead, and the
user gets a raw ``Failed to authenticate. API Error: 401``.

Proven by toggling reachability of the CLI's refresh host
(``platform.claude.com``) both directions on a real box, with an otherwise
identical dead token: blocked → that exact 401 after 122s; reachable → renewed
in under a second and the turn answered normally in 2.8s.

**The renewal must never sit on the critical path — including this one.** The
first version of this module ran the renewal from ``ensure_fresh_before_turn``
and AWAITED it, which moved the entire cost in front of the user's first message
instead of removing it. Measured on a sandbox resumed after a 13-hour gap: the
renewal ran 30.4s, exited 1, refreshed nothing, and the turn then recovered by
itself on its second attempt anyway — 47s to first token, where doing nothing at
all had cost ~16s on the same box the morning before. The guard tripled the wait
it existed to remove.

So the renewal is fire-and-forget, started wherever the app FIRST notices the
credential is spent. In practice that is the hub WebSocket's (re)connect: a box
that was asleep reconnects the moment it wakes — whatever woke it, including the
several wake paths that never log in — and production drops that socket on a
~10-minute cadence regardless, so a spent token is replaced long before anyone
types. ``ensure_fresh_before_turn`` stays as the backstop for a turn that
somehow arrives first, and now only starts the same shared renewal and returns.

**No new cadence is introduced.** Nothing here polls, sleeps, retries or waits.
The check is a 410-byte file read (measured 14µs) hung on events that already
fire, and the renewal is a single task that concurrent callers join rather than
duplicate — which also keeps two CLI processes from refreshing the same
credential file at once.

**This must not hide the bug.** Pre-flighting makes the 401 stop reaching users,
which would also make the underlying flakiness invisible — so every renewal is
logged with its duration, and a slow one is escalated to a WARNING carrying
:data:`SLOW_RENEWAL_MARKER`. A renewal that takes ~1s is routine; one that takes
tens of seconds IS the original incident recurring, now absorbed instead of
surfaced, and that is precisely the signal we had no way to see before.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import time
from pathlib import Path
from typing import AsyncIterator, Optional

from flow_sdk.external_apis.llm.llm_drivers.flow_data import (
    FlowData,
    FlowDataType,
    FlowElementType,
)

logger = logging.getLogger(__name__)

# Only the file-backed layout can be inspected. macOS keeps the credential in
# the login Keychain, where we can neither read the expiry nor safely force a
# rotation — that Keychain also backs the developer's own CLI. Unreadable is
# treated as "not our business", never as "needs renewing".
_CREDENTIALS_FILENAME = ".credentials.json"

# Renew once the token has this little life left. Sized to cover a turn's own
# duration — NOT a retry budget, and not a wait inserted to ride past a failure.
# A token with more life than this is used as-is.
RENEWAL_MARGIN_SECONDS = 10 * 60

# Above this, the renewal was pathologically slow and gets escalated. A healthy
# renewal is ~1s and the whole warm turn ~3s (measured); the incident this was
# written for took 55s. This is a REPORTING threshold — nothing waits on it and
# nothing is retried because of it.
SLOW_RENEWAL_SECONDS = 10.0
SLOW_RENEWAL_MARKER = "CREDENTIAL_RENEWAL_SLOW"

# Chat STATUS subtype for the pre-flight. The floating-chat dense row maps it to
# a human label (``ToolEntryRow.describeOther``).
REFRESH_STATUS_SUBTYPE = "credential_refresh"

# The one in-flight renewal, or None. This handle is what makes "one at a time"
# and "nobody waits" the same mechanism: a caller that finds a live task joins it
# by doing nothing, rather than spawning a second CLI against the same
# credential file. It replaced an ``asyncio.Lock``, which could only serialise
# callers by blocking them — the exact behaviour this module now exists to avoid.
_renewal: Optional["asyncio.Task[None]"] = None


def _credentials_path() -> Path:
    from flow_sdk.instance_settings import get_instance_settings

    return get_instance_settings().claude_home / _CREDENTIALS_FILENAME


def seconds_of_life_left(path: Path | None = None) -> float | None:
    """Remaining access-token life in seconds, or ``None`` if unknowable.

    ``None`` covers every "leave it alone" case in one value: no credential file
    (macOS Keychain, or a CLI that was never logged in), unreadable, or a shape
    we don't recognise.
    """
    try:
        oauth = json.loads((path or _credentials_path()).read_text()).get("claudeAiOauth") or {}
        expires_at_ms = oauth["expiresAt"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    if not isinstance(expires_at_ms, (int, float)):
        return None
    return expires_at_ms / 1000.0 - time.time()


def _refresh_status_frame() -> FlowData:
    return FlowData(
        flow_value={"reason": "credential expired before this turn"},
        attributes={
            "element-type": FlowElementType.STATUS,
            "data-type": FlowDataType.OBJECT,
            "subtype": REFRESH_STATUS_SUBTYPE,
        },
    )


async def _force_renewal() -> None:
    """Make the CLI renew, by giving it the cheapest real turn there is.

    Nothing lighter works — ``--version``, ``--help`` and ``mcp list`` were each
    measured and none of them touch the credential. Renewal happens only on a
    prompt-bearing start, so the warm-up is a real (tiny, haiku) turn whose
    output is discarded.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.stream_worker import _turn_debug_file
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        build_worker_spawn_env,
        resolve_worker_argv0,
    )

    # Debug-logged for the same reason a turn is, and it was the omission that
    # cost the most: on 2026-08-18 this renewal ran 29.6s and exited 1 while the
    # turn 15s behind it recovered from the identical dead token, and the ONLY
    # record of the failure was the CLI's session transcript — one synthetic
    # ``authentication_failed`` line, with nothing about what it tried in
    # between. The turn beside it was fully instrumented and the renewal was
    # not, so the two could not be compared where it mattered. ``_turn_debug_file``
    # (a sibling in this driver) puts the file in the directory we own and prune,
    # rather than ``~/.claude/debug/`` where the CLI's own housekeeping deletes
    # exactly the log you came looking for.
    debug_file = _turn_debug_file("credential-renewal")
    opts = ClaudeAgentOptions(
        model="haiku",
        print_mode=True,
        debug=bool(debug_file),
        debug_file=debug_file,
    )
    argv = opts.cli_cmd(instruction="ok")
    base_env = {k: v for k, v in os.environ.items() if not k.startswith("CLAUDECODE")}
    env = build_worker_spawn_env("claude", dict(opts.env_vars), base_env=base_env)
    argv = resolve_worker_argv0("claude", argv, env)

    started = time.monotonic()
    proc = await asyncio.create_subprocess_exec(
        *argv,
        env=env,
        stdin=asyncio.subprocess.DEVNULL,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
    )
    await proc.wait()
    took = time.monotonic() - started
    left = seconds_of_life_left()
    detail = f"exit={proc.returncode} took={took:.1f}s life_left={'unknown' if left is None else f'{left / 3600:.1f}h'}"
    # Name the debug file on the failure line itself. A path you have to go and
    # derive is a path nobody opens, and this one is the whole point of writing it.
    if debug_file:
        detail = f"{detail} debug={debug_file}"
    if took > SLOW_RENEWAL_SECONDS or proc.returncode != 0:
        # The absorbed incident. Loud on purpose: with the pre-flight in place
        # this no longer reaches a user, so this line is the ONLY evidence that
        # the underlying refresh path is still misbehaving.
        logger.warning("%s claude credential renewal: %s", SLOW_RENEWAL_MARKER, detail)
    else:
        logger.info("claude credential renewal: %s", detail)


async def _renew_guarded() -> None:
    """``_force_renewal`` as a task body: it must never raise into the loop.

    A renewal that fails leaves the credential exactly as it was, which is the
    state every caller already tolerates — the CLI's own retry recovers from it.
    Logged, never propagated, and never retried here.
    """
    try:
        await _force_renewal()
    except Exception:
        logger.warning("claude credential renewal failed", exc_info=True)


def start_renewal_if_stale() -> bool:
    """Start a renewal if the credential is spent. Never waits for it.

    Returns whether the credential is currently spent — which is also the answer
    to "is a renewal in flight", since a spent credential either just started one
    or is already being covered by one.

    Call from anywhere the app learns it may have been idle: the hub WebSocket's
    (re)connect is the load-bearing one, because it fires on every wake path
    rather than only the ones that log in. Cheap enough to call freely — a
    healthy credential costs one file read (measured 14µs) and returns False.

    Must be called with a running event loop; every call site is already async.
    """
    global _renewal
    if (left := seconds_of_life_left()) is None or left > RENEWAL_MARGIN_SECONDS:
        return False
    if _renewal is None or _renewal.done():
        logger.info(
            "claude credential: %.1f min of life left, renewing in the background",
            left / 60,
        )
        _renewal = asyncio.create_task(_renew_guarded(), name="claude-credential-renewal")
    return True


async def ensure_fresh_before_turn() -> AsyncIterator[FlowData]:
    """Backstop for a turn that beat every earlier notice of a spent credential.

    An async iterator so the caller can surface the wait: it yields one STATUS
    frame — and only when the credential is spent — then completes IMMEDIATELY.
    Yields nothing at all on a healthy turn.

    It does not wait for the renewal, and that is the whole point. Waiting is
    what made the original incident worse: the turn's own retry recovers from a
    dead token silently (verified — the recovering turn's transcript holds the
    prompt and the answer and nothing between them), so the useful thing to do
    with the renewal is start it and get out of the way. The STATUS frame stays
    because the person is waiting on the turn either way and the chat may as well
    say why.
    """
    if start_renewal_if_stale():
        yield _refresh_status_frame()
