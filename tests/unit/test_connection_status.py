"""The consolidated connection list.

These rules used to live in the browser (`ui/src/components/credentials-view/
credential-rows.ts`). Moving a fold between languages is where meaning leaks, so
its pins move with it — most of all "a credential exists when its values do",
which is the rule that decides whether a row appears at all.
"""

import pytest

from flow_sdk.core.connections import status as status_mod
from flow_sdk.core.connections.types import ConnectionKind, ConnectionSpec, ConnectionState

pytestmark = pytest.mark.asyncio


class _Source:
    """The verdict shape `list_llm_candidates` hands back."""

    def __init__(self, *, eligible=True, authority="presumed", detail="", reason=""):
        self.eligible = eligible
        self.authority = authority
        self.detail = detail
        self.reason = reason


def _no_harnesses(monkeypatch):
    async def none():
        return []

    monkeypatch.setattr(status_mod, "_harness_rows", none)


def _no_flowpad(monkeypatch):
    async def out():
        return ConnectionSpec(
            provider="flowpad",
            display_name="FlowPad",
            kind=ConnectionKind.FLOWPAD,
            state=ConnectionState.DISCONNECTED,
        )

    monkeypatch.setattr(status_mod, "_flowpad_row", out)


def _oauth(monkeypatch, specs):
    async def rows():
        return specs

    monkeypatch.setattr("flow_sdk.core.connections.specs._list_connection_specs_local", rows)


def _spec(provider, *, connected):
    return ConnectionSpec(
        provider=provider,
        display_name=provider.title(),
        kind=ConnectionKind.OAUTH,
        state=ConnectionState.CONNECTED if connected else ConnectionState.DISCONNECTED,
        connected=connected,
    )


# ── the harness verdict ────────────────────────────────────────────────────


async def test_a_harness_nobody_asked_about_is_unknown_not_disconnected():
    """`login_state` does not survive a restart, so absence is the COMMON case.

    Reporting it as disconnected tells a signed-in user they are signed out every
    time the backend restarts.
    """
    assert status_mod._harness_state(None) is ConnectionState.UNKNOWN
    assert status_mod._harness_state(_Source(authority="presumed")) is ConnectionState.UNKNOWN


async def test_a_harness_is_signed_out_only_when_a_probe_said_so():
    assert status_mod._harness_state(_Source(eligible=False, authority="cached")) is (
        ConnectionState.DISCONNECTED
    )


async def test_a_probed_harness_reads_connected():
    assert status_mod._harness_state(_Source(authority="cached")) is ConnectionState.CONNECTED


# ── what belongs in the list ───────────────────────────────────────────────


async def test_lists_only_held_oauth_grants(monkeypatch):
    """The table shows what exists; an unconnected provider belongs in Add."""
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [_spec("slack", connected=True), _spec("github", connected=False)])

    rows = await status_mod.list_connections()

    assert [r.provider for r in rows if r.kind is ConnectionKind.OAUTH] == ["slack"]


async def test_credentials_need_a_project_and_are_absent_without_one(monkeypatch):
    """Their identity IS `(project_id, env_var)`, and the server has no notion of
    a selected project — so no project means a smaller honest list, not a guess."""
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [])

    rows = await status_mod.list_connections()

    assert [r for r in rows if r.kind is ConnectionKind.API_KEY] == []


async def test_flowpad_and_harnesses_are_machine_scoped(monkeypatch):
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [_spec("slack", connected=True)])
    rows = await status_mod.list_connections()
    assert rows and {r.scope for r in rows} == {"machine"}


# ── the fold's own rule, ported ────────────────────────────────────────────


class _Spec:
    def __init__(self, name, required, all_vars=None):
        self.name = name
        self.title = name.title()
        self.icon_name = ""
        self._required = required
        self._all = all_vars or required

    def var_names(self):
        return list(self._all)

    def required_var_names(self):
        return list(self._required)


class _Resolve:
    def __init__(self, statuses):
        self.data = {"secrets": [{"env_var": k, "status": v} for k, v in statuses.items()]}


class _Project:
    def __init__(self, statuses):
        self._statuses = statuses

    async def secret_resolve_status(self):
        return _Resolve(self._statuses)


def _specs(monkeypatch, specs):
    class _CredentialSpec:
        @staticmethod
        async def get_all():
            return specs

    monkeypatch.setattr("flow_sdk.builtin.credential_spec.CredentialSpec", _CredentialSpec)


async def test_a_credential_exists_when_its_values_do(monkeypatch):
    _specs(monkeypatch, [_Spec("gmail", ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"])])
    project = _Project({"GMAIL_ADDRESS": "available", "GMAIL_APP_PASSWORD": "available"})

    rows = await status_mod._credential_rows(project)

    assert [r.provider for r in rows] == ["gmail"]
    assert rows[0].connected and rows[0].scope == "project"
    assert rows[0].env_vars == ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD")


async def test_a_half_satisfied_credential_is_not_a_row(monkeypatch):
    """No partial states, by design: "not there, not seen". A credential without
    its values is not a connection — it is an entry in the Add dialog."""
    _specs(monkeypatch, [_Spec("twilio", ["TWILIO_ACCOUNT_SID", "TWILIO_AUTH_TOKEN"])])
    project = _Project({"TWILIO_ACCOUNT_SID": "available", "TWILIO_AUTH_TOKEN": "missing"})

    assert await status_mod._credential_rows(project) == []


async def test_an_optional_member_does_not_hold_a_working_credential_back(monkeypatch):
    """Required-only, exactly as `required_var_names` documents."""
    _specs(
        monkeypatch,
        [_Spec("openrouter", ["OPENROUTER_API_KEY"], all_vars=["OPENROUTER_API_KEY", "SITE_URL"])],
    )
    project = _Project({"OPENROUTER_API_KEY": "available", "SITE_URL": "missing"})

    rows = await status_mod._credential_rows(project)

    assert [r.provider for r in rows] == ["openrouter"]
    # The row still names every variable it is made of, satisfied or not.
    assert rows[0].env_vars == ("OPENROUTER_API_KEY", "SITE_URL")
