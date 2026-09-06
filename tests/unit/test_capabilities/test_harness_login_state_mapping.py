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

import subprocess

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


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.harness_login_state.rules: FAILING? the harness's own 'Not logged
#       in' refusal is no longer recorded - read this tag's rules before touching report_signed_out_action
# flowpad:endcapsule tag
@pytest.mark.asyncio
async def test_harness_denial_clears_a_stale_authenticated(monkeypatch) -> None:
    """The other half of the rule above: an undetermined probe must not preserve
    a POSITIVE claim once the harness itself has denied it.

    Leaving ``login_state`` alone on an undetermined probe is right — it is
    evidence about the probe, not about login. But ``login_state`` is written by
    the last device login and nothing invalidates it when the user signs out
    elsewhere, so "leave it alone" also means a months-old ``authenticated``
    survives every probe that times out. The harness-login modal then opened ON
    Claude Code's ``"Not logged in · Please run /login"`` and greeted the user
    with a green "Signed in" — the modal contradicting the error that summoned
    it. The CLI's own refusal is the best evidence there is about this box, and
    ``report-signed-out`` is the one writer for it.
    """
    monkeypatch.setenv("PATH", BARE_PATH)
    monkeypatch.setenv("SHELL", "/bin/sh")
    await run_discovery([CLAUDE_KIND])

    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None, "harness.claude.cli row should be seeded"

    # A login that succeeded once and has since been revoked outside FlowPad.
    capability.login_state = DeviceLoginState.AUTHENTICATED
    denial = "Not logged in · Please run /login"
    response = await capability.report_signed_out_action(message=denial)

    assert (response.data or {}).get("recorded") is True
    assert capability.login_state == DeviceLoginState.IDLE, (
        f"the harness said {denial!r} but the capability still reports "
        f"login_state={capability.login_state!r} — the login modal renders that as 'Signed in'"
    )
    assert capability.login_message == denial

    # And the probe that cannot decide must not undo it — an undetermined probe
    # moves the field in NEITHER direction.
    await capability.auth_status_action()
    assert capability.login_state == DeviceLoginState.IDLE


@pytest.mark.asyncio
async def test_denial_does_not_clobber_a_login_in_flight(monkeypatch) -> None:
    """A stale turn error is older than the sign-in the user is doing right now."""
    monkeypatch.setenv("PATH", BARE_PATH)
    monkeypatch.setenv("SHELL", "/bin/sh")
    await run_discovery([CLAUDE_KIND])

    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None
    capability.login_state = DeviceLoginState.AWAITING_USER

    response = await capability.report_signed_out_action(message="Not logged in")

    assert (response.data or {}).get("recorded") is False
    assert capability.login_state == DeviceLoginState.AWAITING_USER


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.harness_login_state.rules: FAILING? a presence-only auth probe
#       is overturning a sign-out the harness itself reported - read this tag's rules
#       before touching _mirror_probe_to_login_state or probe_claude_auth's verified
#       flag
# flowpad:endcapsule tag
@pytest.mark.asyncio
async def test_probe_may_not_overturn_a_refusal_the_cli_itself_made(monkeypatch) -> None:
    """A credential that EXISTS must not outrank a credential that FAILED.

    ``claude auth status`` reads the credential off disk and never asks the
    server whether it still works — with ``ANTHROPIC_BASE_URL`` pointed at a dead
    port it still answers ``loggedIn: true``. So an expired or revoked credential
    reports "logged in" while the same binary answers a real turn with
    ``"Not logged in · Please run /login"``.

    That is the contradiction the user hit: the harness-login modal opened
    BECAUSE the harness refused the turn, and greeted them with a green "Signed
    in" — the fresh probe it runs on open genuinely says so, every time, and so
    restores the exact state the refusal had just corrected.

    The sequence below is the product's own, in order: the turn fails, the
    refusal is recorded (``report-signed-out``, what
    ``useHarnessLoginOnAuthError`` calls), then the modal's ``auth-status`` probe
    runs. Nothing is mocked — both halves run the REAL ``claude`` binary the
    capability discovered, through the product's own env resolution, and the
    invalid credential is a real present-but-dead one.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        resolve_worker_probe_context,
    )

    # A credential that is present and cannot authenticate.
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-invalid-000")
    await run_discovery([CLAUDE_KIND])

    context = resolve_worker_probe_context("claude")
    if context is None:
        pytest.skip("claude CLI not installed on this machine")
    executable, env = context

    # 1. THE TURN — the CLI itself, same binary and same env, refuses. This is
    #    the sentence `tail_status_detail` lifts into `worker_status_detail` and
    #    the one that opens the harness-login modal.
    turn = subprocess.run(
        [executable, "-p", "say hi"],
        capture_output=True,
        text=True,
        timeout=60,
        env=env,
        stdin=subprocess.DEVNULL,  # -p reads stdin; without this it waits on an empty pipe
    )
    output = (turn.stdout or "") + (turn.stderr or "")
    refusal = next((ln.strip() for ln in output.splitlines() if "not logged in" in ln.lower()), "")
    assert refusal, f"precondition: this credential should make the CLI refuse the turn, got {output[:300]!r}"

    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None, "harness.claude.cli row should be seeded"

    # 2. THE REFUSAL IS RECORDED — what the frontend does with that sentence.
    await capability.report_signed_out_action(message=refusal)
    assert capability.login_state == DeviceLoginState.IDLE

    # 3. THE MODAL OPENS and re-probes. The probe finds the stored credential
    #    and answers logged_in — truthfully, about presence.
    response = await capability.auth_status_action()
    assert (response.data or {}).get("status") == WorkerAuthStatus.LOGGED_IN.value, (
        "precondition: the probe should still report the stored credential as logged_in"
    )

    assert capability.login_state != DeviceLoginState.AUTHENTICATED, (
        f"the CLI refused the turn with {refusal!r}, but a probe that only checked whether a "
        f"credential EXISTS flipped the capability back to login_state={capability.login_state!r} "
        f"— which the modal renders as a green 'Signed in' on top of the very error that opened it"
    )


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.harness_login_state.rules: FAILING? a user-invoked Test can no
#       longer clear a recorded refusal - read this tag's rules before touching auth_status_action's
#       force flag
# flowpad:endcapsule tag
@pytest.mark.asyncio
async def test_an_explicit_test_clears_a_recorded_refusal(monkeypatch) -> None:
    """The user must never be stuck signed-out after fixing it themselves.

    A refusal outranks the probe, so a harness the user re-authorised OUTSIDE
    FlowPad (``claude /login`` in their own terminal) would read as signed out
    forever. The "Test" button is the user saying they fixed it — that probe,
    and only that one, is allowed to clear the refusal.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
        resolve_worker_probe_context,
    )

    # Any stored credential puts the probe in its "logged_in" state; the test
    # runtime isolates HOME, so carry one in the env rather than depending on
    # whose machine this runs on.
    monkeypatch.setenv("ANTHROPIC_AUTH_TOKEN", "sk-ant-invalid-000")
    await run_discovery([CLAUDE_KIND])
    if resolve_worker_probe_context("claude") is None:
        pytest.skip("claude CLI not installed on this machine")
    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None

    await capability.report_signed_out_action(message="Not logged in · Please run /login")
    assert capability.login_denied is True
    assert capability.login_state == DeviceLoginState.IDLE

    response = await capability.auth_status_action(force=True)
    assert (response.data or {}).get("status") == WorkerAuthStatus.LOGGED_IN.value

    assert capability.login_denied is False
    assert capability.login_state == DeviceLoginState.AUTHENTICATED, (
        "an explicit user-invoked Test found a working login but the capability stayed signed out"
    )


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.harness_login_state.rules: FAILING? auth-status no longer re-probes
#       the DEVICE login of a harness a hub endpoint funds - read this tag's rules before
#       touching auth_status_action's api branch
# flowpad:endcapsule tag
@pytest.mark.parametrize("endpoint_eligible", [True, False])
@pytest.mark.asyncio
async def test_a_hub_funded_harness_still_reports_its_own_device_login(monkeypatch, endpoint_eligible: bool) -> None:
    """A budget funding the where harness must not answer for the vendor's OAuth session.

    Two failures lived in this one branch, and the user met them as one thing: the
    LLM-sources screen calling a signed-in ``claude`` "signed out", and a Sign in button
    standing where the Use button belongs -- the one control that switches funding back
    to the device login.

    * ``source.provider`` does not exist (``LLMSource`` NAMES an endpoint and mirrors none
      of its fields), so the action 500'd for exactly the harnesses a key or a hub endpoint
      funds. ``login_state`` then froze at whatever the last sweep saw, and a user who
      signed in afterwards had no surface that would notice.
    * the synthesized api-mode result -- ``logged_in`` iff the ENDPOINT is eligible -- was
      mirrored back onto ``login_state``, so a judgement about a hub budget overwrote the
      field that means "is this device login signed in".
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import get_driver
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source as llm_source_mod
    from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthResult
    from flow_sdk.builtin.llm_endpoint import LLMEndpoint, LLMEndpointKind
    from flow_sdk.schema.data_spec.llm_source_spec import LLMSource

    await run_discovery([CLAUDE_KIND])
    capability = await Capability.get_by_kind(CLAUDE_KIND)
    assert capability is not None

    endpoint = LLMEndpoint.projection(
        LLMEndpointKind.HUB, "llm_endpoint-test-budget", name="Gadi +20", provider="openrouter"
    )
    verdict = LLMSource(
        endpoint_typeid=str(endpoint.typeid),
        name="Gadi +20",
        eligible=endpoint_eligible,
        reason="" if endpoint_eligible else "this budget is exhausted",
    )

    async def fake_resolve(worker_type: str):
        return llm_source_mod.Candidate(endpoint, verdict)

    monkeypatch.setattr(llm_source_mod, "resolve_box_llm_endpoint", fake_resolve)

    # The vendor CLI is signed in. That is the answer the whole action exists to carry,
    # and it must survive whatever the budget's own verdict says.
    async def signed_in_probe():
        return WorkerAuthResult(
            status=WorkerAuthStatus.LOGGED_IN,
            verified=False,
            message="claude CLI has stored credentials (not validated).",
            identity="gadi@langware.ai",
            plan="max",
        )

    monkeypatch.setattr(type(get_driver("claude")), "auth_probe", lambda self: signed_in_probe())

    response = await capability.auth_status_action()
    data = response.data or {}
    assert data.get("auth_mode") == "api", f"a hub-funded harness should report api mode, got {data!r}"
    assert data.get("details", {}).get("provider") == "openrouter", (
        "the ENDPOINT's provider belongs in the details -- reading it off the verdict raised "
        "AttributeError and 500'd the action"
    )
    assert data.get("details", {}).get("device_login") == WorkerAuthStatus.LOGGED_IN.value

    assert capability.login_state == DeviceLoginState.AUTHENTICATED, (
        f"the vendor CLI is signed in, but a verdict about the hub budget "
        f"(eligible={endpoint_eligible}) left login_state={capability.login_state!r} -- the "
        f"LLM-sources screen renders anything but 'authenticated' as 'claude is signed out' "
        f"and offers Sign in where it should offer Use"
    )
