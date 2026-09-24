"""The consolidated connection list.

These rules used to live in the browser (`ui/src/components/credentials-view/
credential-rows.ts`). Moving a fold between languages is where meaning leaks, so
its pins move with it — most of all "a credential exists when its values do",
which is the rule that decides whether a row appears at all.
"""

import pytest

from flow_sdk.core.connections import status as status_mod
from flow_sdk.schema.data_spec.connection_spec import ConnectionKind, ConnectionSpec, ConnectionState

pytestmark = pytest.mark.asyncio


class _Source:
    """The verdict shape `list_llm_candidates` hands back."""

    def __init__(self, *, eligible=True, authority="presumed", detail="", reason=""):
        self.eligible = eligible
        self.authority = authority
        self.detail = detail
        self.reason = reason


def _no_harnesses(monkeypatch):
    async def none(**_):
        return []

    monkeypatch.setattr(status_mod, "_harness_rows", none)


def _no_flowpad(monkeypatch):
    async def out():
        return ConnectionSpec(
            provider="flowpad_account",
            display_name="FlowPad",
            kind=ConnectionKind.FLOWPAD,
            state=ConnectionState.DISCONNECTED,
        )

    monkeypatch.setattr(status_mod, "_flowpad_row", out)


def _oauth(monkeypatch, specs):
    async def rows():
        return specs

    monkeypatch.setattr("flow_sdk.core.connections.specs._list_connection_specs_local", rows)


def _no_credentials(monkeypatch):
    async def none(project):
        return []

    monkeypatch.setattr(status_mod, "_credential_rows", none)


def _api_row(provider, *, scope):
    return ConnectionSpec(
        provider=provider,
        display_name=provider.title(),
        kind=ConnectionKind.API_KEY,
        state=ConnectionState.CONNECTED,
        connected=True,
        scope=scope,
    )


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


@pytest.mark.parametrize("authority", ["cached", "proven"])
async def test_a_probed_harness_reads_connected(authority):
    """`proven` is here on purpose. It is the STRONGEST verdict the resolver can
    issue, and the browser ladder this fold replaces let it fall through to "nobody
    has asked" — the same drift, one language over."""
    assert status_mod._harness_state(_Source(authority=authority)) is ConnectionState.CONNECTED


# ── which harnesses are rows at all ────────────────────────────────────────


def _installed(monkeypatch, workers):
    """Only *workers* have a CLI on this machine."""
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver.worker_executable",
        lambda w: "/usr/local/bin/" + w if w in workers else None,
    )


async def test_a_harness_that_is_not_installed_is_not_a_row(monkeypatch):
    """A sign-in status for a CLI you never installed is a question about
    nothing — and four such rows, all reading "Not checked", is how the column
    stopped meaning anything."""
    _installed(monkeypatch, {"claude"})

    assert status_mod._installed_harnesses() == ["claude"]


# ── checking, which is a WRITE ─────────────────────────────────────────────


class _Cap:
    """Enough of a harness `Capability` for the check: the field it reads and
    the refresh it calls."""

    def __init__(self, login_state=None):
        self.login_state = login_state
        self.refreshed = 0

    async def refresh_login_state(self):
        self.refreshed += 1
        self.login_state = "authenticated"
        return None


def _caps(monkeypatch, by_worker):
    async def _get(worker):
        return by_worker.get(worker)

    monkeypatch.setattr(status_mod, "_harness_capability", _get)


async def test_checking_asks_the_harnesses_nobody_asked_about(monkeypatch):
    _installed(monkeypatch, {"claude"})
    cap = _Cap()
    _caps(monkeypatch, {"claude": cap})

    checked = await status_mod.check_harness_logins()

    assert cap.refreshed == 1
    assert checked == {"claude": "authenticated"}


async def test_checking_again_re_shells_nothing(monkeypatch):
    """`login_state` means exactly "somebody asked". Re-probing an answered
    harness would run a vendor CLI to learn what is already known — which is what
    makes this safe to fire on every visit to the screen."""
    _installed(monkeypatch, {"claude"})
    cap = _Cap(login_state="authenticated")
    _caps(monkeypatch, {"claude": cap})

    assert await status_mod.check_harness_logins() == {}
    assert cap.refreshed == 0


async def test_force_asks_again(monkeypatch):
    """The user saying "look again" — the same words the Test button uses."""
    _installed(monkeypatch, {"claude"})
    cap = _Cap(login_state="idle")
    _caps(monkeypatch, {"claude": cap})

    await status_mod.check_harness_logins(force=True)

    assert cap.refreshed == 1


async def test_a_vendor_that_cannot_be_reached_costs_a_verdict_not_the_screen(monkeypatch):
    _installed(monkeypatch, {"claude", "codex"})
    ok = _Cap()

    class _Broken(_Cap):
        async def refresh_login_state(self):
            raise RuntimeError("the CLI is wedged")

    _caps(monkeypatch, {"claude": _Broken(), "codex": ok})

    assert await status_mod.check_harness_logins() == {"codex": "authenticated"}


# ── how it signs in ────────────────────────────────────────────────────────


def test_a_harness_with_an_account_of_its_own_signs_in_by_device_login():
    assert status_mod._sign_in_for("claude") == "device"


def test_a_harness_funded_only_by_a_key_signs_in_by_api_key():
    """deepagents has no account of its own (``has_device_login=False``); a
    device-login icon on its row claimed a sign-in that cannot exist."""
    assert status_mod._sign_in_for("deepagents") == "api_key"


def test_sign_in_survives_the_wire():
    spec = ConnectionSpec(provider="x", display_name="X", sign_in="api_key")
    assert ConnectionSpec.from_wire(spec.model_dump(mode="json")).sign_in == "api_key"


# ── what account it is ─────────────────────────────────────────────────────


async def test_the_account_says_which_vendor_account_is_signed_in():
    assert status_mod._account_for("copilot", _Cap(), ConnectionState.CONNECTED) == "GitHub account"


async def test_a_reported_plan_refines_the_account_in_the_vendors_own_words():
    """The plan is normalized by the PROBE, which is the layer that knows claude
    spells it `subscriptionType`. Capitalised and otherwise untouched — a tier
    name of our own would be a claim about billing."""
    cap = _Cap()
    cap.login_plan = "max"

    assert status_mod._account_for("claude", cap, ConnectionState.CONNECTED) == "Anthropic account · Max"


async def test_nothing_is_claimed_for_a_harness_that_is_not_signed_in():
    """An account line under "Not checked" asserts what the status just declined
    to."""
    cap = _Cap()
    cap.login_plan = "max"
    for state in (ConnectionState.UNKNOWN, ConnectionState.DISCONNECTED):
        assert status_mod._account_for("claude", cap, state) == ""


# ── what belongs in the list ───────────────────────────────────────────────


async def test_lists_only_held_oauth_grants(monkeypatch):
    """The table shows what exists; an unconnected provider belongs in Add."""
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [_spec("slack", connected=True), _spec("github", connected=False)])

    _no_credentials(monkeypatch)
    rows = await status_mod.list_connections()

    assert [r.provider for r in rows if r.kind is ConnectionKind.OAUTH] == ["slack"]


async def test_include_unconnected_keeps_every_oauth_provider_in_screen_order(monkeypatch):
    """The SDK's list: the same order, the OAuth block complete, each row saying
    whether it is connected. Default (screen, CLI) stays held-only."""
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [_spec("github", connected=True), _spec("slack", connected=False)])
    monkeypatch.setattr(status_mod, "_credential_rows", _async_rows([_api_row("OPENAI", scope="user")]))

    held = await status_mod.list_connections()
    every = await status_mod.list_connections(include_unconnected=True)

    assert [r.provider for r in held] == ["flowpad_account", "github", "OPENAI"]
    assert [(r.provider, r.connected) for r in every] == [
        ("flowpad_account", False),
        ("github", True),
        ("slack", False),
        ("OPENAI", True),
    ]


def _async_rows(specs):
    async def rows(project):
        return specs

    return rows


async def test_user_credentials_are_listed_without_a_project(monkeypatch):
    """User-scope credentials apply to every project, so they are rows even when
    no project is named; the call passes the project through unchanged."""
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _oauth(monkeypatch, [])
    seen = []

    async def rows(project):
        seen.append(project)
        return [_api_row("personal", scope="user")]

    monkeypatch.setattr(status_mod, "_credential_rows", rows)

    listed = await status_mod.list_connections()

    assert seen == [None]
    assert [(r.provider, r.scope) for r in listed if r.kind is ConnectionKind.API_KEY] == [("personal", "user")]


async def test_flowpad_and_harnesses_are_machine_scoped(monkeypatch):
    _no_harnesses(monkeypatch)
    _no_flowpad(monkeypatch)
    _no_credentials(monkeypatch)
    _oauth(monkeypatch, [_spec("slack", connected=True)])
    rows = await status_mod.list_connections()
    assert rows and {r.scope for r in rows} == {"machine"}


# ── credential rows come from the credential status ─────────────────────


def _status(monkeypatch, rows):
    from flow_sdk.schema.data_spec.credential_status_spec import (
        CredentialsStatusSpec,
        CredentialStatusRowSpec,
        CredentialVarStatusSpec,
    )

    status = CredentialsStatusSpec(
        credentials=[
            CredentialStatusRowSpec(
                typeid=f"secret_pack-{name}",
                name=name,
                title=name.title(),
                scope=scope,
                value_store="env",
                state=state,
                vars=[CredentialVarStatusSpec(env_var=v, present=state == "connected") for v in env_vars],
            )
            for name, scope, state, env_vars in rows
        ]
    )

    async def fake(project):
        return status

    monkeypatch.setattr("flow_sdk.builtin.credential_status.credentials_status", fake)


async def test_a_credential_is_a_connection_when_its_values_are_there(monkeypatch):
    _status(monkeypatch, [("gmail", "project", "connected", ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"])])

    rows = await status_mod._credential_rows(object())

    assert [r.provider for r in rows] == ["gmail"]
    assert rows[0].connected and rows[0].scope == "project"
    assert rows[0].env_vars == ("GMAIL_ADDRESS", "GMAIL_APP_PASSWORD")
    assert rows[0].sign_in == "api_key"


async def test_a_partial_or_missing_credential_is_not_a_row(monkeypatch):
    """"Not there, not seen": a credential without its values is not a
    connection — it is set up from the Connections screen."""
    _status(monkeypatch, [("twilio", "project", "partial", ["A", "B"]), ("slack", "user", "missing", ["C"])])

    assert await status_mod._credential_rows(object()) == []


async def test_a_row_carries_its_own_scope(monkeypatch):
    _status(monkeypatch, [("personal", "user", "connected", ["P"]), ("team", "project", "connected", ["T"])])

    rows = await status_mod._credential_rows(object())

    assert [(r.provider, r.scope) for r in rows] == [("personal", "user"), ("team", "project")]


# ── provider ids are names ────────────────────────────────────────────────────


async def test_provider_ids_are_unique_across_the_real_composition(monkeypatch):
    """Every lookup (`get_connection`, `match_provider`, `connect`) addresses a row by
    provider id alone, so two rows sharing one make the second unreachable by name.

    The FlowPad account row and the "FlowPad (OAuth)" catalogue provider both said
    ``flowpad`` — `get_connection("flowpad")` could never reach the OAuth one. This
    runs the REAL row producers (account, every harness, the whole local OAuth
    catalogue); only their external reads are stubbed."""
    from flow_sdk.builtin.agentic_process.cli_drivers import llm_source
    from flow_sdk.builtin.agentic_process.cli_drivers.hub_endpoint_binding import HUB_ENDPOINT_HARNESSES
    from flow_sdk.cloud_client import auth_state
    from flow_sdk.core.connections import specs
    from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars
    from flow_sdk.core.oauth import hub_providers

    async def nothing(*_args, **_kwargs):
        return None

    async def no_hub():
        return EntityEnvVars(values=[])

    monkeypatch.setattr(auth_state, "login_block", lambda: {})
    monkeypatch.setattr(status_mod, "_installed_harnesses", lambda: list(HUB_ENDPOINT_HARNESSES))
    monkeypatch.setattr(status_mod, "_harness_capability", nothing)
    monkeypatch.setattr(llm_source, "device_candidate", nothing)
    monkeypatch.setattr(hub_providers, "hub_provider_rows", no_hub)
    monkeypatch.setattr(specs, "_connection_user", nothing)
    _no_credentials(monkeypatch)

    rows = await status_mod.list_connections(include_unconnected=True)
    ids = [r.provider.strip().lower() for r in rows]

    assert {r.kind for r in rows} >= {ConnectionKind.FLOWPAD, ConnectionKind.HARNESS, ConnectionKind.OAUTH}
    assert "flowpad" in ids, "the FlowPad OAuth provider must stay addressable as 'flowpad'"
    assert sorted({i for i in ids if ids.count(i) > 1}) == []
    account = next(r for r in rows if r.kind is ConnectionKind.FLOWPAD)
    assert account.provider == "flowpad_account"
