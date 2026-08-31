"""A probe that cannot determine login state must not read as "not signed in".

``docs/interface/cli-drivers.md`` pins the driver-layer contract: ``auth_probe``
returns ``NOT_INSTALLED`` when discovery has no bin folder and ``UNKNOWN`` when
the probe could not decide — "never conflated with ``LOGGED_OUT``". The drivers
honour that; ``Capability.auth_status_action`` then collapses all four statuses
into two, filing everything that is not ``logged_in`` as ``login_state="idle"``.

``idle`` is the footer's "not signed in" signal: ``isHarnessLoginRequired``
(``ts_sdk/src/react/hooks/useWarnings.ts``) warns on any truthy ``login_state``
that is not ``authenticated``. So a sweep that merely failed to SEE the CLI —
no ``SHELL``, dotfiles that never add the folder, the probe's own cap — ends up
telling the user their signed-in harness is signed out.

Real discovery sweep, real Capability row, real probe. The degraded environment
is the actual trigger, not a stand-in for it.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
    DeviceLoginState,
    WorkerAuthStatus,
)
from flow_sdk.builtin.capability import Capability
from flow_sdk.core.capabilities.discovery import run_discovery

CLAUDE_KIND = "harness.claude.cli"

# What macOS hands a Dock-launched app: no login shell ran, so the user's
# personal tool folders are absent. `/bin/sh` keeps the sweep's login-shell
# recovery from re-reading the user's real dotfiles.
BARE_PATH = "/usr/bin:/bin:/usr/sbin:/sbin"

# The states the footer reads as "installed but not signed in".
SIGNED_OUT_STATES = {DeviceLoginState.IDLE.value, DeviceLoginState.ERROR.value}


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.harness_login_state.rules: FAILING? an undetermined auth probe
#       is being recorded as signed out - read this tag's rules before touching _mirror_probe_to_login_state
#       or the probe status mapping
# flowpad:endcapsule tag
@pytest.mark.asyncio
async def test_undetermined_login_is_not_reported_as_signed_out(monkeypatch) -> None:
    monkeypatch.setenv("PATH", BARE_PATH)
    monkeypatch.setenv("SHELL", "/bin/sh")
    await run_discovery([CLAUDE_KIND])

    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None, "harness.claude.cli row should be seeded"

    response = await capability.auth_status_action()
    status = (response.data or {}).get("status")
    assert status == WorkerAuthStatus.NOT_INSTALLED.value, (
        f"expected the degraded sweep to yield a NOT_INSTALLED probe, got {status!r}"
    )

    assert capability.login_state not in SIGNED_OUT_STATES, (
        f"probe returned {status!r} — it could not determine login state — but the "
        f"capability now reports login_state={capability.login_state!r}, which the "
        f"footer renders as 'a coding agent CLI is installed but not signed in'"
    )
