"""The consolidated connection list.

These rules used to live in the browser (`ui/src/components/credentials-view/
credential-rows.ts`). Moving a fold between languages is where meaning leaks, so
its pins move with it — most of all "a credential exists when its values do",
which is the rule that decides whether a row appears at all.
"""

import pytest

from flow_sdk.core.connections import status as status_mod
from flow_sdk.core.status.spec import (
    AccountSpec,
    HarnessStatusSpec,
    HubLogin,
    HubStatusSpec,
    InstallState,
    LoginState,
    StatusSpec,
)
from flow_sdk.schema.data_spec.connection_spec import ConnectionKind, ConnectionSpec, ConnectionState

pytestmark = pytest.mark.asyncio


def _h(
    worker="claude", *, install=InstallState.INSTALLED, login=LoginState.NOT_CHECKED, plan="", device=True, message=""
):
    """One harness's status record, as ``core.status`` builds it."""
    return HarnessStatusSpec(
        kind=f"harness.{worker}.cli",
        worker_type=worker,
        label=worker.title(),
        install=install,
        login=login,
        login_message=message,
        account=AccountSpec(identity="me@example.com" if login is LoginState.SIGNED_IN else "", plan=plan),
        has_device_login=device,
    )


def _record(monkeypatch, *, harnesses=(), hub=HubLogin.SIGNED_OUT):
    """Stub the status record ``list_connections`` projects from."""

    async def build():
        return StatusSpec(harnesses=tuple(harnesses), keys=(), hub=HubStatusSpec(login=hub))

    monkeypatch.setattr("flow_sdk.core.status.build_status", build)


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


# ── the harness row is a projection of its status record ───────────────────


async def test_a_harness_nobody_asked_about_is_unknown_not_disconnected():
    """Reporting "never probed" as disconnected tells a signed-in user they are signed out."""
    assert status_mod._harness_row(_h(login=LoginState.NOT_CHECKED)).state is ConnectionState.UNKNOWN


async def test_a_harness_is_signed_out_only_when_a_probe_said_so():
    assert status_mod._harness_row(_h(login=LoginState.SIGNED_OUT)).state is ConnectionState.DISCONNECTED


async def test_a_probed_harness_reads_connected():
    row = status_mod._harness_row(_h(login=LoginState.SIGNED_IN))
    assert row.state is ConnectionState.CONNECTED and row.connected
    assert row.identity == "me@example.com"


@pytest.mark.parametrize("install", [InstallState.NOT_INSTALLED, InstallState.UNKNOWN])
async def test_a_harness_that_is_not_installed_is_a_row_that_says_so(install):
    """Not "Not checked" (a login question about a CLI that is not there) and not absent
    (which hid why nothing funds it)."""
    row = status_mod._harness_row(_h(install=install, login=LoginState.N_A))
    assert row.state is ConnectionState.NOT_INSTALLED
    assert not row.connected
    assert "not installed" in row.detail


async def test_every_harness_in_the_record_is_a_row_in_its_order(monkeypatch):
    _record(
        monkeypatch,
        harnesses=[_h("claude", login=LoginState.SIGNED_IN), _h("codex", install=InstallState.NOT_INSTALLED)],
    )
    _oauth(monkeypatch, [])
    _no_credentials(monkeypatch)

    rows = [r for r in await status_mod.list_connections() if r.kind is ConnectionKind.HARNESS]

    assert [(r.provider, r.state) for r in rows] == [
        ("claude", ConnectionState.CONNECTED),
        ("codex", ConnectionState.NOT_INSTALLED),
    ]


def _installed(monkeypatch, workers):
    """Only *workers* have a CLI on this machine."""
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver.worker_executable",
        lambda w: "/usr/local/bin/" + w if w in workers else None,
    )


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
    assert status_mod._harness_row(_h(device=True)).sign_in == "device"


def test_a_harness_funded_only_by_a_key_signs_in_by_api_key():
    """deepagents has no account of its own (``has_device_login=False``); a
    device-login icon on its row claimed a sign-in that cannot exist."""
    row = status_mod._harness_row(_h("deepagents", install=InstallState.BUILT_IN, login=LoginState.N_A, device=False))
    assert row.sign_in == "api_key"
    assert row.state is ConnectionState.N_A


def test_sign_in_survives_the_wire():
    spec = ConnectionSpec(provider="x", display_name="X", sign_in="api_key")
    assert ConnectionSpec.from_wire(spec.model_dump(mode="json")).sign_in == "api_key"


# ── what account it is ─────────────────────────────────────────────────────


async def test_the_account_says_which_vendor_account_is_signed_in():
    assert status_mod._account_for(_h("copilot", login=LoginState.SIGNED_IN)) == "GitHub account"


async def test_a_reported_plan_refines_the_account_in_the_vendors_own_words():
    """Capitalised and otherwise untouched — a tier name of our own would be a claim
    about billing."""
    assert status_mod._account_for(_h("claude", login=LoginState.SIGNED_IN, plan="max")) == "Anthropic account · Max"


@pytest.mark.parametrize("login", [LoginState.NOT_CHECKED, LoginState.SIGNED_OUT, LoginState.ERROR])
async def test_nothing_is_claimed_for_a_harness_that_is_not_signed_in(login):
    """An account line under "Not checked" asserts what the status just declined to."""
    assert status_mod._account_for(_h("claude", login=login, plan="max")) == ""


# ── the FlowPad account ───────────────────────────────────────────────────


@pytest.mark.parametrize(
    ("hub", "state"),
    [
        (HubLogin.SIGNED_IN, ConnectionState.CONNECTED),
        (HubLogin.SIGNED_OUT, ConnectionState.DISCONNECTED),
        (HubLogin.REJECTED, ConnectionState.NEEDS_REAUTH),
        (HubLogin.SIGNING_IN, ConnectionState.SIGNING_IN),
        (HubLogin.OFFLINE, ConnectionState.UNKNOWN),
    ],
)
def test_the_flowpad_row_is_the_hubs_own_answer(hub, state):
    assert status_mod._flowpad_row(HubStatusSpec(login=hub)).state is state


# ── what belongs in the list ───────────────────────────────────────────────


async def test_lists_only_held_oauth_grants(monkeypatch):
    """The table shows what exists; an unconnected provider belongs in Add."""
    _record(monkeypatch)
    _oauth(monkeypatch, [_spec("slack", connected=True), _spec("github", connected=False)])

    _no_credentials(monkeypatch)
    rows = await status_mod.list_connections()

    assert [r.provider for r in rows if r.kind is ConnectionKind.OAUTH] == ["slack"]


async def test_include_unconnected_keeps_every_oauth_provider_in_screen_order(monkeypatch):
    """The SDK's list: the same order, the OAuth block complete, each row saying
    whether it is connected. Default (screen, CLI) stays held-only."""
    _record(monkeypatch)
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
    _record(monkeypatch)
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
    _record(monkeypatch)
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
                typeid=f"credential-{name}",
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
    """ "Not there, not seen": a credential without its values is not a
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
    from flow_sdk.builtin.capability import Capability
    from flow_sdk.core.connections import specs
    from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars
    from flow_sdk.core.oauth import hub_providers

    async def nothing(*_args, **_kwargs):
        return None

    async def no_hub():
        return EntityEnvVars(values=[])

    # The REAL status record (every vendor), with no harness rows stored.
    monkeypatch.setattr(Capability, "get_by_kind", classmethod(lambda cls, kind: nothing()))
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
