"""The status layer: one reader per fact, read once, never presumed.

The Windows box this was built for had no harness CLI installed and FlowPad signed out, and
every surface still said Claude was signed in and funding calls. These pin the facts at their
source, before any funding or UI reads them.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import DeviceLoginState
from flow_sdk.core.status import build as build_mod
from flow_sdk.schema.data_spec.status_spec import HubLogin, InstallState, LoginState

pytestmark = pytest.mark.asyncio


class _Cap:
    def __init__(self, login_state=None, *, denied=None):
        self.login_state = login_state
        self.login_denied = denied


# ── login: one translation, never presumed ───────────────────────────────────


@pytest.mark.parametrize(
    ("stored", "expected"),
    [
        (None, LoginState.NOT_CHECKED),
        (DeviceLoginState.AUTHENTICATED, LoginState.SIGNED_IN),
        ("authenticated", LoginState.SIGNED_IN),
        (DeviceLoginState.IDLE, LoginState.SIGNED_OUT),
        (DeviceLoginState.ERROR, LoginState.ERROR),
        (DeviceLoginState.STARTING, LoginState.SIGNING_IN),
        (DeviceLoginState.AWAITING_USER, LoginState.SIGNING_IN),
    ],
)
async def test_an_installed_harness_reports_exactly_what_was_probed(stored, expected):
    assert build_mod.login_state(InstallState.INSTALLED, True, _Cap(stored)) is expected


@pytest.mark.parametrize("install", [InstallState.NOT_INSTALLED, InstallState.UNKNOWN])
async def test_a_missing_cli_has_no_login_whatever_the_row_says(install):
    """The proven bug: a stored or never-probed login read for a CLI that is not there."""
    for stored in (None, DeviceLoginState.AUTHENTICATED):
        assert build_mod.login_state(install, True, _Cap(stored)) is LoginState.N_A


async def test_a_key_only_harness_has_no_login():
    assert build_mod.login_state(InstallState.BUILT_IN, False, _Cap(None)) is LoginState.N_A


async def test_a_refusal_from_the_harness_outranks_a_stored_credential():
    cap = _Cap(DeviceLoginState.AUTHENTICATED, denied=True)
    assert build_mod.login_state(InstallState.INSTALLED, True, cap) is LoginState.SIGNED_OUT


# ── installed ────────────────────────────────────────────────────────────────


def _exe(monkeypatch, found: dict[str, str]):
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver.worker_executable",
        lambda w: found.get(w),
    )


def _swept(monkeypatch, done: bool):
    monkeypatch.setattr("flow_sdk.core.capabilities.discovery.has_discovered", lambda: done)


async def test_a_cli_on_disk_is_installed_and_a_python_harness_is_built_in(monkeypatch):
    _exe(monkeypatch, {"claude": "/usr/local/bin/claude", "deepagents": "/usr/bin/python3"})
    _swept(monkeypatch, True)
    assert build_mod.harness_install("claude") is InstallState.INSTALLED
    assert build_mod.harness_install("deepagents") is InstallState.BUILT_IN
    assert build_mod.harness_install("codex") is InstallState.NOT_INSTALLED


async def test_absent_before_the_first_sweep_is_unknown_not_missing(monkeypatch):
    _exe(monkeypatch, {})
    _swept(monkeypatch, False)
    assert build_mod.harness_install("claude") is InstallState.UNKNOWN
    assert not build_mod.is_installed("claude")


# ── keys: names only ─────────────────────────────────────────────────────────


async def test_stored_keys_are_read_by_name_and_never_opened(monkeypatch):
    monkeypatch.setattr(
        "flow_sdk.cli.auth.secrets.get_secrets",
        lambda: [{"name": "lm_api.openrouter", "created_at": "2026-10-01"}, {"name": "github.token"}],
    )
    assert build_mod.stored_key_providers() == {"openrouter": "2026-10-01"}
    keys = {k.provider: k.stored for k in build_mod._keys()}
    assert keys == {"openrouter": True, "anthropic": False, "openai": False}


async def test_a_stored_keys_masked_hint_is_carried_and_an_old_record_has_none(monkeypatch):
    """The shadow's ``****last4`` reaches the key slot; a record written before hints existed
    reads as "" rather than failing, and an empty slot carries nothing."""
    monkeypatch.setattr(
        "flow_sdk.cli.auth.secrets.get_secrets",
        lambda: [
            {"name": "lm_api.openrouter", "created_at": "2026-10-01", "hint": "****ab12"},
            {"name": "lm_api.anthropic", "created_at": "2026-09-01"},
        ],
    )
    assert build_mod.stored_key_hints() == {"openrouter": "****ab12", "anthropic": ""}
    hints = {k.provider: k.hint for k in build_mod._keys()}
    assert hints == {"openrouter": "****ab12", "anthropic": "", "openai": ""}


# ── hub: the hub's own answer ────────────────────────────────────────────────


class _Ws:
    def __init__(self, status="disconnected", *, verified=False, error=None):
        self._status = status
        self.is_verified = verified
        self._error = error

    def connection_payload(self):
        return {"status": self._status, "error": self._error}


def _hub(monkeypatch, *, creds: bool, ws: _Ws, login="logged_in", user=None):
    from flow_sdk.cloud_client.auth_status import HubLoginStatus

    monkeypatch.setattr("flow_sdk.cli.auth.hub_login.hub_auth_available", lambda: creds)
    monkeypatch.setattr("flow_sdk.cloud_client.auth_state.current_login_status", lambda: HubLoginStatus(login))
    monkeypatch.setattr("flow_sdk.cloud_client.ws_client.hub_ws_manager", ws)
    monkeypatch.setattr("flow_sdk.cli.app_config.get_user", lambda: user)


async def test_no_credential_is_signed_out(monkeypatch):
    _hub(monkeypatch, creds=False, ws=_Ws(), login="logged_out")
    assert build_mod.hub_status().login is HubLogin.SIGNED_OUT


async def test_signed_in_means_the_hub_named_the_user(monkeypatch):
    _hub(monkeypatch, creds=True, ws=_Ws("verified", verified=True), user={"id": "u1", "email": "a@b.c"})
    hub = build_mod.hub_status()
    assert (hub.login, hub.email, hub.user_typeid) == (HubLogin.SIGNED_IN, "a@b.c", "user-u1")


async def test_a_stored_credential_the_hub_has_not_confirmed_is_offline(monkeypatch):
    """A headless box with a key is not "signed out" -- and not signed in until the hub says so."""
    _hub(monkeypatch, creds=True, ws=_Ws("error", error="unreachable"))
    hub = build_mod.hub_status()
    assert (hub.login, hub.error) == (HubLogin.OFFLINE, "unreachable")


async def test_a_refused_credential_is_rejected(monkeypatch):
    _hub(monkeypatch, creds=True, ws=_Ws("auth_rejected"))
    assert build_mod.hub_status().login is HubLogin.REJECTED


async def test_a_login_in_flight_is_signing_in(monkeypatch):
    _hub(monkeypatch, creds=False, ws=_Ws("connecting"), login="logging_in")
    assert build_mod.hub_status().login is HubLogin.SIGNING_IN


@pytest.mark.parametrize(
    ("output", "version"),
    [("GitHub Copilot CLI 1.0.88.", "1.0.88"), ("2.1.288 (Claude Code)", "2.1.288"), ("no version here", "")],
)
async def test_the_version_is_the_number_not_the_sentence_around_it(output, version):
    class _Checked:
        last_check = {"details": {"output": output}}

    assert build_mod._version(_Checked()) == version


@pytest.mark.parametrize(("records", "pruned", "published"), [(["a", "a"], False, 0), (["a", "b"], False, 1), (["a", "a"], True, 1)])
async def test_a_refresh_pushes_only_when_something_changed(monkeypatch, records, pruned, published):
    """Every client re-reads status, funding and connections on a push, and screens refresh on
    arrival -- a sweep that found what was already known must not set all of that off."""
    import flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding as binding
    import flow_sdk.core.capabilities.discovery as discovery
    import flow_sdk.core.status.build as build
    import flow_sdk.core.status.refresh as refresh

    answers = iter(records)
    pushes: list[int] = []

    async def _build():
        return next(answers)

    async def _nothing(*_a, **_k):
        return None

    async def _prune():
        return pruned

    monkeypatch.setattr(build, "build_status", _build)
    monkeypatch.setattr(discovery, "run_discovery", _nothing)
    monkeypatch.setattr(binding, "prune_dead_binding", _prune)
    monkeypatch.setattr(refresh, "publish_status_changed", lambda: pushes.append(1))

    await refresh.refresh_status(["harness.claude.cli"])

    assert len(pushes) == published
