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
    async def none(**_):
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
