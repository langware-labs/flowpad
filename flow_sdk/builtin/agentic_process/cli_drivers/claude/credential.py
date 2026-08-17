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

**Scope, deliberately narrow.** This is not a guard against a token dying
mid-session — that case doesn't happen; the CLI renews it and moves on. The only
case addressed is: *a long time has passed since the last call, so we don't know
whether the next one will work.* That question has exactly one moment where it
can be asked and one place where the answer is knowable — right before we spawn a
turn, by reading the credential's own recorded expiry. So the check lives there
and nowhere else: no timer, no scheduled job, no background polling. On every
turn but the first after a long gap it is one 410-byte file read (measured 14µs).

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
from typing import AsyncIterator

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

# Renew if the token would expire during the turn we are about to start. Sized
# to cover a turn's own duration — NOT a retry budget, and not a wait inserted
# to ride past a failure. A token with more life than this is used as-is.
PREFLIGHT_MARGIN_SECONDS = 10 * 60

# Above this, the renewal was pathologically slow and gets escalated. A healthy
# renewal is ~1s and the whole warm turn ~3s (measured); the incident this was
# written for took 55s. This is a REPORTING threshold — nothing waits on it and
# nothing is retried because of it.
SLOW_RENEWAL_SECONDS = 10.0
SLOW_RENEWAL_MARKER = "CREDENTIAL_RENEWAL_SLOW"

# Chat STATUS subtype for the pre-flight. The floating-chat dense row maps it to
# a human label (``ToolEntryRow.describeOther``).
REFRESH_STATUS_SUBTYPE = "credential_refresh"

_lock = asyncio.Lock()


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
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        build_worker_spawn_env,
        resolve_worker_argv0,
    )

    opts = ClaudeAgentOptions(model="haiku", print_mode=True)
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
    if took > SLOW_RENEWAL_SECONDS or proc.returncode != 0:
        # The absorbed incident. Loud on purpose: with the pre-flight in place
        # this no longer reaches a user, so this line is the ONLY evidence that
        # the underlying refresh path is still misbehaving.
        logger.warning("%s claude credential renewal: %s", SLOW_RENEWAL_MARKER, detail)
    else:
        logger.info("claude credential renewal: %s", detail)


async def ensure_fresh_before_turn() -> AsyncIterator[FlowData]:
    """Renew the credential first if this turn would otherwise have to.

    An async iterator so the caller can surface the wait: it yields one STATUS
    frame — and only when a renewal actually happens — then completes once the
    credential is usable. Yields nothing at all on a healthy turn.

    A failure here is deliberately swallowed: the turn then behaves exactly as it
    does today, so the pre-flight can only ever help.
    """
    if (left := seconds_of_life_left()) is None or left > PREFLIGHT_MARGIN_SECONDS:
        return
    async with _lock:
        # Re-read under the lock: concurrent turns queue here, and the first one
        # through has already renewed on behalf of the rest.
        if (left := seconds_of_life_left()) is None or left > PREFLIGHT_MARGIN_SECONDS:
            return
        logger.info(
            "claude credential pre-flight: %.1f min of life left, renewing before the turn",
            left / 60,
        )
        yield _refresh_status_frame()
        try:
            await _force_renewal()
        except Exception:
            logger.warning("claude credential pre-flight failed", exc_info=True)
