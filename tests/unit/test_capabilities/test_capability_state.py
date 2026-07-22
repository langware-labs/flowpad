"""CapabilityState four-state model + tri-state check_capability + gh/github kinds.

Pure/seam-injected — no subprocess, no network, no live DB beyond the isolated
driver the entity fixtures provide.
"""
from __future__ import annotations

import pytest

import flow_sdk.core.capabilities.discovery as discovery_mod
from flow_sdk.builtin.capability import Capability
from flow_sdk.core.capabilities import (
    CapabilityKind,
    CapabilityResult,
    CapabilityState,
    capability_kind_matches,
    get_capability_registry,
)
from flow_sdk.core.capabilities.models import CapabilityValue
from flow_sdk.core.capabilities.registry import (
    GhCliCapabilityRunner,
    GithubAccountRunner,
    gh_device_login_spec,
)


@pytest.fixture(autouse=True)
def _clear_discovery_dict():
    discovery_mod._VALUES.clear()
    discovery_mod._DISCOVERED_ONCE.clear()
    yield
    discovery_mod._VALUES.clear()
    discovery_mod._DISCOVERED_ONCE.clear()


def _result(*, available: bool, state: str | None = None) -> CapabilityResult:
    kwargs = {"ok": True, "available": available, "message": ""}
    if state is not None:
        kwargs["state"] = state
    return CapabilityResult(**kwargs)


# ── derive_state transition table ────────────────────────────────────────────

@pytest.mark.parametrize(
    ("row_state", "available", "attempted", "expected"),
    [
        # available always wins
        ("none", True, False, "available"),
        ("not_available", True, False, "available"),
        ("error", True, True, "available"),
        # passive discovery never promotes NONE → NOT_AVAILABLE
        ("none", False, False, "none"),
        # explicit attempt does
        ("none", False, True, "not_available"),
        # an engaged row (already non-NONE) may fall back passively
        ("available", False, False, "not_available"),
        ("not_available", False, False, "not_available"),
    ],
)
def test_derive_state_table(row_state, available, attempted, expected):
    row = Capability(kind="x", state=row_state)
    assert row.derive_state(_result(available=available), attempted=attempted) == expected


def test_derive_state_error_passthrough():
    row = Capability(kind="x")
    err = _result(available=False, state=CapabilityState.ERROR.value)
    assert row.derive_state(err, attempted=True) == "error"


def test_derive_state_prior_install_counts_as_engaged():
    row = Capability(kind="x", state="none", last_install={"ok": False})
    assert row.derive_state(_result(available=False)) == "not_available"


# ── kind grammar ─────────────────────────────────────────────────────────────

def test_source_control_kind_matching():
    assert capability_kind_matches(CapabilityKind.GITHUB.value, CapabilityKind.GITHUB_GH.value)
    assert capability_kind_matches("source_control", CapabilityKind.GITHUB.value)
    assert not capability_kind_matches(CapabilityKind.GITHUB_GH.value, CapabilityKind.GITHUB.value)


def test_github_kinds_registered_with_specs():
    registry = get_capability_registry()
    assert isinstance(registry.get(CapabilityKind.GITHUB.value), GithubAccountRunner)
    gh = registry.get(CapabilityKind.GITHUB_GH.value)
    assert isinstance(gh, GhCliCapabilityRunner)
    assert gh.spec.install_prompt and "auth login" in gh.spec.install_prompt


# ── tri-state check_capability ───────────────────────────────────────────────

@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("state", "expected"),
    [("available", True), ("not_available", False), ("none", None), ("error", None)],
)
async def test_check_capability_mapping(monkeypatch, state, expected):
    from flow_sdk.core import capabilities as caps

    async def fake_get_by_kind(kind):
        return Capability(kind=kind, state=state)

    monkeypatch.setattr(Capability, "get_by_kind", fake_get_by_kind)
    assert await caps.check_capability("source_control.github.gh") is expected


# ── gh runner ────────────────────────────────────────────────────────────────

@pytest.mark.asyncio
async def test_gh_check_not_installed():
    runner = get_capability_registry().get(CapabilityKind.GITHUB_GH.value)
    result = await runner.check()
    assert result.available is False
    assert result.details.get("installed") is False


@pytest.mark.asyncio
async def test_gh_check_installed_auth_seam(monkeypatch):
    discovery_mod.set_capability_value(
        CapabilityValue(
            kind=CapabilityKind.GITHUB_GH.value,
            value={"path": "/opt/gh/bin", "ref_type": "folder"},
            value_type="folder",
            message="seeded",
        )
    )
    runner = get_capability_registry().get(CapabilityKind.GITHUB_GH.value)

    async def authed(path):
        return True

    monkeypatch.setattr(runner, "_is_authenticated", authed)
    result = await runner.check()
    assert result.available is True
    assert result.details == {
        "executable": "gh",
        "path": "/opt/gh/bin/gh",
        "installed": True,
        "authenticated": True,
    }


@pytest.mark.asyncio
async def test_github_parent_aggregation(monkeypatch):
    runner = get_capability_registry().get(CapabilityKind.GITHUB.value)

    async def token_present():
        return "tok"

    async def token_absent():
        return None

    # OAuth wins
    monkeypatch.setattr(runner, "_oauth_token", token_present)
    result = await runner.check()
    assert result.available is True and result.details["method"] == "oauth"

    # no OAuth, gh unavailable (nothing discovered) → not available
    monkeypatch.setattr(runner, "_oauth_token", token_absent)
    result = await runner.check()
    assert result.available is False

    # no OAuth, gh available → available via gh
    gh = get_capability_registry().get(CapabilityKind.GITHUB_GH.value)

    async def gh_ok():
        return CapabilityResult(ok=True, available=True, message="")

    monkeypatch.setattr(gh, "check", gh_ok)
    result = await runner.check()
    assert result.available is True and result.details["method"] == "gh"


def test_gh_device_login_spec_scrapes_canned_output():
    from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import (
        clean_pty_output,
        find_auto_answer,
        scrape_device_login,
    )

    spec = gh_device_login_spec()
    raw = (
        "! First copy your one-time code: ABCD-1234\r\n"
        "Press Enter to open https://github.com/login/device in your browser...\r\n"
    )
    clean = clean_pty_output(raw)
    url, code = scrape_device_login(clean, spec)
    assert url == "https://github.com/login/device"
    assert code == "ABCD-1234"
    answer = find_auto_answer(clean, set())
    assert answer is not None and answer[1] == "\r"


# ── registry check() traps probe crashes as ERROR ────────────────────────────

@pytest.mark.asyncio
async def test_registry_check_traps_probe_exception(monkeypatch):
    registry = get_capability_registry()
    runner = registry.get(CapabilityKind.GITHUB_GH.value)

    async def boom():
        raise RuntimeError("probe exploded")

    monkeypatch.setattr(runner, "check", boom)
    check = await registry.check(CapabilityKind.GITHUB_GH.value)
    assert check.result.available is False
    assert check.result.state == CapabilityState.ERROR.value

    with pytest.raises(KeyError):
        await registry.check("no.such.kind")
