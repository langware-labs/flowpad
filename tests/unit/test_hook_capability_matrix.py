"""harness x scope x event — every cell either works or says why not.

The point of this file is ALIGNMENT, not exhaustive coverage: one row per
mechanism, because that is what actually adds coverage. Two events that travel
the identical code path (``SessionStart`` and ``UserPromptSubmit`` both become
one ``-c hooks.<Event>=`` slot on codex) prove the same thing twice, so only one
of them is here. What differs per cell — and is therefore worth a row — is the
scope's delivery mechanism and whether the harness supports it at all.

Artifact-level assertions (the exact plugin.json / hooks.json / TOML bytes) stay
in the per-driver runtime tests; this file is purely about the gate.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.hooks import HookEventType, HookScope, get_hook_manager
from flow_sdk.builtin.hooks.capabilities import PROCESS_EVENTS

HARNESSES = ("claude", "codex", "copilot", "opencode")

#: Driver name -> the ``WorkerType`` value an AgenticProcess row carries. They
#: differ for claude ("claude" vs "claude_code"), which is why ``get_driver``
#: owns an alias map and ``get_hook_manager`` delegates to it instead of
#: re-deriving one.
WORKER_TYPE = {
    "claude": "claude_code",
    "codex": "codex",
    "copilot": "copilot",
    "opencode": "opencode",
}
GLOBAL_SCOPES = (HookScope.USER, HookScope.PROJECT, HookScope.LOCAL_PROJECT)

#: One representative per mechanism family. More names would not exercise more code.
REPRESENTATIVE = HookEventType.USER_PROMPT_SUBMIT

#: The declared truth, mirrored here so a silent capability change fails loudly.
#: global scope -> harnesses that support it.
EXPECTED_GLOBAL = {"claude"}
#: process scope -> harnesses that support it.
EXPECTED_PROCESS = {"claude", "codex", "copilot", "opencode"}


def _process_manager(harness: str):
    """A ProcessHooksManager bound to a throwaway process for ``harness``."""
    from flow_sdk.builtin.agentic_process import AgenticProcess

    process = AgenticProcess(name=f"matrix-{harness}", worker_type=WORKER_TYPE[harness])
    return process.hooks


# ── global scopes ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("harness", HARNESSES)
@pytest.mark.parametrize("scope", GLOBAL_SCOPES)
def test_global_cell_is_supported_iff_declared(harness: str, scope: HookScope):
    manager = get_hook_manager(harness)
    supported = harness in EXPECTED_GLOBAL

    assert (scope in manager.supported_scopes()) is supported, (
        f"{harness}/{scope.value} support changed — update EXPECTED_GLOBAL, "
        "and make sure the driver's hook_capabilities() really can do this."
    )

    if supported:
        assert manager.require(REPRESENTATIVE, scope) is not None
    else:
        with pytest.raises(NotImplementedError, match=harness):
            manager.require(REPRESENTATIVE, scope)


# ── process scope ───────────────────────────────────────────────────────────


@pytest.mark.parametrize("harness", HARNESSES)
def test_process_cell_is_supported_iff_declared(harness: str):
    manager = _process_manager(harness)
    supported = harness in EXPECTED_PROCESS

    assert (HookScope.PROCESS in manager.supported_scopes()) is supported

    if supported:
        assert manager.require(REPRESENTATIVE) is not None
    else:
        with pytest.raises(NotImplementedError):
            manager.require(REPRESENTATIVE)


#: The three vendors whose process tier shipped together and must stay in lockstep.
V1_VENDORS = ("claude", "codex", "copilot")


@pytest.mark.parametrize("harness", V1_VENDORS)
def test_v1_vendors_support_exactly_the_same_event_set(harness: str):
    """These three shipped together — drift between them is a bug, not a feature."""
    assert _process_manager(harness).supported_events() == PROCESS_EVENTS


@pytest.mark.parametrize("harness", sorted(EXPECTED_PROCESS))
def test_no_vendor_declares_an_event_outside_the_catalogue(harness: str):
    """A vendor may support FEWER events, never an event nobody else knows.

    opencode declares two of the three: its ``session.idle`` fires at TURN end,
    not session end, so mapping SessionEnd would fire it on every turn.
    """
    assert _process_manager(harness).supported_events() <= PROCESS_EVENTS


def test_opencode_declares_the_subset_it_can_actually_serve():
    from flow_sdk.builtin.hooks import HookEventType as E

    assert _process_manager("opencode").supported_events() == frozenset(
        {E.USER_PROMPT_SUBMIT, E.SESSION_START}
    )


# ── cross-cutting invariants ────────────────────────────────────────────────


@pytest.mark.parametrize("harness", HARNESSES)
def test_a_manager_never_serves_the_other_half(harness: str):
    """Global and process managers are disjoint — no cell is served by both."""
    global_scopes = get_hook_manager(harness).supported_scopes()
    process_scopes = _process_manager(harness).supported_scopes()

    assert HookScope.PROCESS not in global_scopes
    assert not (process_scopes - {HookScope.PROCESS})
    assert not (global_scopes & process_scopes)


@pytest.mark.parametrize("harness", HARNESSES)
def test_response_events_are_a_subset_of_supported_events(harness: str):
    """A harness cannot answer an event it cannot even fire."""
    for manager in (get_hook_manager(harness), _process_manager(harness)):
        for scope, cap in manager.capabilities().items():
            assert cap.response_events <= cap.events, f"{harness}/{scope.value}"


def test_unknown_event_name_is_rejected_uniformly():
    from flow_sdk.builtin.hooks.manager import normalize_event

    with pytest.raises(ValueError, match="unknown hook event"):
        normalize_event("NoSuchEvent")


def test_a_driver_that_declares_nothing_is_off_by_construction():
    """The state a newly added vendor starts from — no blocklist required.

    Deliberately a stub rather than a real vendor: this property must hold for
    whichever harness is added next, and every real one eventually grows hooks.
    (OpenCode was the example until it declared Process scope.)
    """
    from flow_sdk.builtin.hooks.global_manager import GlobalHooksManager

    class BrandNewDriver:
        name = "brand-new-harness"

    manager = GlobalHooksManager(BrandNewDriver())

    assert manager.supported_scopes() == frozenset()
    with pytest.raises(NotImplementedError, match="brand-new-harness"):
        manager.require(REPRESENTATIVE, HookScope.USER)
