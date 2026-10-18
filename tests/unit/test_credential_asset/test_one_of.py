"""``ONE_OF``: a credential's either-or group, and the ``cli`` variable that can be one of its ways.

Acme's Google access is the case: a service-account key file OR a gcloud sign-in — either is enough,
and a sign-in is nothing a store holds. Real isolated DB, real project, real credential service; the
sign-in's check is a real shell one-liner (``exit 0`` / ``exit 1``).
"""
from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from dotenv import dotenv_values
from pydantic import ValidationError

from flow_sdk.builtin import credential_service, credential_status, project_setup
from flow_sdk.builtin.credential_resolver import credentials_in_scope, declare
from flow_sdk.builtin.credential_service import CredentialError, save_credential
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.cli.commands.credentials_cmd import _missing, from_inputs
from flow_sdk.core.compute_op import ask
from flow_sdk.core.compute_op.ask import open_questions
from flow_sdk.core.wizard.state import input_env
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec
from flow_sdk.schema.data_spec.project_setup_spec import ONE_OF_INPUT, input_name

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SA_KEY = json.dumps({"type": "service_account", "project_id": "demo", "private_key": "-----not-a-real-key-----"})
KEY, SIGN_IN = "GOOGLE_APPLICATION_CREDENTIALS", "GCLOUD_ADC"


def _every_os(command: str) -> dict:
    return {"commands": {p: command for p in ("darwin", "linux", "win32")}}


def gcp(*, signed_in: bool = False) -> dict:
    return {
        "name": "google-cloud", "setup": "A key file, or sign in with gcloud.",
        "vars": {
            KEY: {"required": "ONE_OF", "kind": "file", "label": "Service-account key",
                  "pattern": '"type":\\s*"service_account"'},
            SIGN_IN: {"required": "ONE_OF", "kind": "cli", "label": "Sign in with gcloud",
                      "login": _every_os("gcloud auth application-default login"),
                      "check": _every_os("exit 0" if signed_in else "exit 1")},
        },
    }


@pytest.fixture(autouse=True)
def _no_sources(monkeypatch):
    async def none(_project):
        return []

    monkeypatch.setattr(project_setup, "project_sources", none)


async def _row(project):
    (row,) = [r for r in (await credentials_status(project)).credentials if r.name == "google-cloud"]
    return row


# ── the declaration ──────────────────────────────────────────────────────────


def _spec(vars: dict) -> CredentialSpec:
    return CredentialSpec(schema=2, name="x", setup="…", vars=vars)


async def test_one_of_is_a_choice_so_one_alone_is_refused():
    with pytest.raises(ValidationError, match="at least two ONE_OF"):
        _spec({"A": {"required": "ONE_OF"}, "B": {}})
    assert _spec({"A": {"required": "ONE_OF"}, "B": {"required": "ONE_OF"}})


async def test_a_cli_variable_declares_its_login_and_check_and_nothing_else_does():
    with pytest.raises(ValidationError, match="login and its check"):
        _spec({"A": {"kind": "cli"}})
    with pytest.raises(ValidationError, match="belong to a cli variable"):
        _spec({"A": {"check": _every_os("exit 0")}})


async def test_a_sign_in_is_never_a_stored_or_injected_variable(project):
    spec = await save_credential(manifest=gcp(), scope="project", project_id=project.id)

    assert (spec.var_names(), spec.stored_var_names()) == ([KEY, SIGN_IN], [KEY])
    assert set(declare(await credentials_in_scope(project))) == {KEY}
    with pytest.raises(CredentialError, match="is a sign-in, not a value"):
        await credential_service.set_credential_values(str(spec.typeid), {SIGN_IN: "anything"})


# ── status: any one way is enough ────────────────────────────────────────────


async def test_with_neither_way_the_credential_is_missing(project):
    await save_credential(manifest=gcp(), scope="project", project_id=project.id)

    row = await _row(project)

    assert row.state == "missing"
    assert [(v.env_var, v.required, v.kind, v.store, v.present) for v in row.vars] == [
        (KEY, "ONE_OF", "file", "env", False), (SIGN_IN, "ONE_OF", "cli", "cli", False),
    ]
    assert row.vars[1].login == "gcloud auth application-default login"
    assert _missing(row.model_dump(mode="json")) == [KEY, SIGN_IN]


async def test_the_key_file_alone_connects_and_the_sign_in_is_not_even_checked(project, monkeypatch):
    spec = await save_credential(manifest=gcp(), scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {KEY: SA_KEY})

    async def never(_var):
        pytest.fail("a settled group must not run the sign-in's check")

    monkeypatch.setattr(credential_status, "_signed_in", never)
    row = await _row(project)

    assert row.state == "connected"
    assert _missing(row.model_dump(mode="json")) == []


async def test_the_sign_in_alone_connects_with_nothing_stored(project):
    await save_credential(manifest=gcp(signed_in=True), scope="project", project_id=project.id)

    row = await _row(project)

    assert row.state == "connected"
    assert [(v.env_var, v.present) for v in row.vars] == [(KEY, False), (SIGN_IN, True)]
    assert dotenv_values(Path(project.fs_storage_mount_path) / ".env.local") == {}


async def test_a_must_beside_the_group_is_still_needed(project):
    manifest = gcp(signed_in=True)
    manifest["vars"]["GOOGLE_CLOUD_PROJECT"] = {"secret": False}
    await save_credential(manifest=manifest, scope="project", project_id=project.id)

    assert (await _row(project)).state == "partial"


# ── project setup ────────────────────────────────────────────────────────────


async def test_readiness_asks_for_the_group_until_one_way_is_there(project, templates):
    spec = await save_credential(manifest=gcp(), scope="project", project_id=project.id)

    readiness = await project_setup.readiness_of(project)
    assert [(r.name, [v.env_var for v in r.missing]) for r in readiness.to_do] == [("google-cloud", [KEY, SIGN_IN])]

    await credential_service.set_credential_values(str(spec.typeid), {KEY: SA_KEY})
    assert (await project_setup.readiness_of(project)).ready is True


async def test_a_sign_in_makes_the_project_ready(project, templates):
    await save_credential(manifest=gcp(signed_in=True), scope="project", project_id=project.id)

    assert (await project_setup.readiness_of(project)).ready is True


async def test_the_group_compiles_to_one_question_with_a_choice_per_way(project, templates):
    await save_credential(manifest=gcp(), scope="project", project_id=project.id)
    reqs = await project_setup.collect_requirements(project)

    wizard, ops = project_setup.compile_setup(project.id, reqs)

    assert [s.id for s in wizard.steps] == ["ask-google-cloud-one-of", "store-google-cloud"]
    assert wizard.steps[0].bind == input_name("google-cloud", ONE_OF_INPUT)
    ask = ops["ask-google-cloud-one-of"]
    assert [(c.value, c.file, c.command) for c in ask.exe_data.choices] == [
        (KEY, True, ""), (SIGN_IN, False, "gcloud auth application-default login"),
    ]
    assert ask.exe_data.auto_continue, "a sign-in is done in a terminal: the question closes by itself"
    assert ask.completion_check == ops["store-google-cloud"].completion_check


async def test_the_app_is_asked_one_question_offering_both_ways(project, templates, monkeypatch):
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", True)  # this process is the backend a tab draws the question from
    await save_credential(manifest=gcp(), scope="project", project_id=project.id)

    await project_setup.start_setup(project, ai=False)
    try:
        for _ in range(200):
            if open_questions():
                break
            await asyncio.sleep(0.01)
        (question,) = open_questions()
        payload = question.to_payload()
        assert [(c["value"], c["file"], c["command"]) for c in payload["choices"]] == [
            (KEY, True, ""), (SIGN_IN, False, "gcloud auth application-default login"),
        ]
        assert payload["auto"] is True
    finally:
        project_setup._RUNS.pop((str(project.id), "")).cancel()


async def test_the_picked_way_reaches_the_store_step_as_its_variable():
    def env(answer) -> dict:
        return input_env({input_name("google-cloud", ONE_OF_INPUT): answer})

    assert from_inputs("google-cloud", env(f"{KEY}={SA_KEY}")) == ({KEY: SA_KEY}, "")
    assert from_inputs("google-cloud", env({})) == ({}, ""), "closed by a sign-in: nothing to store"


async def test_the_setups_own_check_is_answered_in_process_on_every_os():
    """Windows spells the check as a PowerShell call; it is answered in-process there too. As a process it
    took 27 s on a loaded Windows box — past the check's limit, so a connected credential read as missing."""
    from flow_sdk.core.flow_command import flow_command

    for platform in ("win32", "darwin", "linux"):
        command = flow_command("credentials", "check", "google-cloud", "--project", "p1", platform=platform)
        assert project_setup._own_check(command) == ("google-cloud", "p1", ""), platform
    assert project_setup._own_check(flow_command("credentials", "set", "x", platform="win32")) is None


# ── an oauth way: "Sign in with Google" or an app password, chosen per machine ──

MAIL = "https://mail.google.com/"
ADDRESS, GOOGLE, APP_PASSWORD = "GMAIL_ADDRESS", "GMAIL_GOOGLE", "GMAIL_APP_PASSWORD"


def mail() -> dict:
    return {
        "name": "mailbox", "setup": "Sign in with Google, or an app password.",
        "vars": {
            ADDRESS: {"secret": False},
            GOOGLE: {"required": "ONE_OF", "kind": "oauth", "provider": "Google", "scopes": [MAIL], "secret": False},
            APP_PASSWORD: {"required": "ONE_OF"},
        },
    }


def _granted(monkeypatch, scopes=(MAIL,)):
    """The connection list holds a Google grant covering ``scopes`` (``None``: no grant at all)."""
    from flow_sdk.core.connections import specs
    from flow_sdk.schema.data_spec.connection_spec import ConnectionKind, ConnectionSpec, ConnectionState

    async def listed():
        if scopes is None:
            return []
        return [ConnectionSpec(provider="google", display_name="Google", kind=ConnectionKind.OAUTH,
                               state=ConnectionState.CONNECTED, connected=True, scopes=list(scopes))]

    monkeypatch.setattr(specs, "_list_connection_specs_local", listed)


async def _mail_row(project):
    (row,) = [r for r in (await credentials_status(project)).credentials if r.name == "mailbox"]
    return row


async def test_an_oauth_variable_is_a_provider_way_of_a_group_and_nothing_else():
    with pytest.raises(ValidationError, match="names its provider"):
        _spec({"A": {"required": "ONE_OF", "kind": "oauth"}, "B": {"required": "ONE_OF"}})
    with pytest.raises(ValidationError, match="one way of a ONE_OF group"):
        _spec({"A": {"kind": "oauth", "provider": "google"}})
    with pytest.raises(ValidationError, match="belong to an oauth variable"):
        _spec({"A": {"provider": "google"}})
    spec = CredentialSpec.model_validate({**mail(), "schema": 2})
    assert spec.vars[GOOGLE].provider == "google" and not spec.vars[GOOGLE].holds_value


async def test_a_grant_way_is_never_stored_and_reads_present_from_the_connection(project, monkeypatch):
    spec = await save_credential(manifest=mail(), scope="project", project_id=project.id)
    assert spec.stored_var_names() == [ADDRESS, APP_PASSWORD]
    with pytest.raises(CredentialError, match="not a value"):
        await credential_service.set_credential_values(str(spec.typeid), {GOOGLE: "a token"})

    _granted(monkeypatch, scopes=())
    google = next(v for v in (await _mail_row(project)).vars if v.env_var == GOOGLE)
    assert (google.store, google.present, google.provider, google.scopes) == ("connection", False, "google", [MAIL])

    _granted(monkeypatch)
    await credential_service.set_credential_values(str(spec.typeid), {ADDRESS: "me@gmail.com"})
    row = await _mail_row(project)
    assert row.state == "connected" and row.setup_choice == ""


async def test_storing_one_way_chooses_it_on_the_row_and_never_in_the_file(project, templates, monkeypatch):
    from flow_sdk.builtin.credential import Credential

    _granted(monkeypatch, scopes=None)
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    folder = Path(project.fs_storage_mount_path) / "agentic-assets" / "credential" / "mailbox"
    before = (folder / "credential.json").read_text()

    await credential_service.set_credential_by_name(
        "mailbox", {ADDRESS: "me@gmail.com", APP_PASSWORD: "abcd"}, project_id=str(project.id))

    row = await Credential.get("mailbox", project)
    assert row.setup_choice == APP_PASSWORD and (await _mail_row(project)).setup_choice == APP_PASSWORD
    assert (folder / "credential.json").read_text() == before, "a choice is the person's here, never the declaration's"
    with pytest.raises(AttributeError, match="projection"):
        row.setup_choice = GOOGLE


async def test_the_chosen_way_alone_decides_the_group(project, templates, monkeypatch):
    _granted(monkeypatch)
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    await credential_service.set_credential_by_name("mailbox", {ADDRESS: "me@gmail.com"}, project_id=str(project.id))
    assert (await _mail_row(project)).state == "connected", "unchosen: any way there is enough"

    await credential_service.set_credential_by_name("mailbox", {}, project_id=str(project.id), choice=APP_PASSWORD)
    row = await _mail_row(project)
    assert row.state == "partial" and row.missing == [APP_PASSWORD], "chosen: the grant no longer settles it"
    assert (await project_setup.readiness_of(project)).ready is False

    await credential_service.set_credential_by_name("mailbox", {}, project_id=str(project.id), choice=GOOGLE)
    assert (await _mail_row(project)).state == "connected"
    assert (await project_setup.readiness_of(project)).ready is True


async def test_a_choice_naming_a_way_no_longer_declared_counts_as_unset(project, templates, monkeypatch):
    from flow_sdk.builtin.credential import Credential, write_setup_choice

    _granted(monkeypatch)
    spec = await save_credential(manifest=mail(), scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {ADDRESS: "me@gmail.com"})
    row = await Credential.get("mailbox", project)
    await write_setup_choice(row, APP_PASSWORD)
    row._set_projection("setup_choice", "GMAIL_RETIRED", __import__(
        "flow_sdk.core.entity.projected_fields", fromlist=["PROJECTION_SENTINEL"]).PROJECTION_SENTINEL)
    assert row.chosen == ""
    with pytest.raises(ValueError, match="not one of"):
        await write_setup_choice(row, ADDRESS)


async def test_a_bare_way_records_the_choice_and_an_unknown_one_is_refused(project, templates, monkeypatch):
    from flow_sdk.builtin.credential import Credential

    _granted(monkeypatch)
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    await credential_service.set_credential_by_name("mailbox", {}, project_id=str(project.id), choice=GOOGLE)
    assert (await Credential.get("mailbox", project)).setup_choice == GOOGLE
    with pytest.raises(CredentialError, match="not one of"):
        await credential_service.set_credential_by_name("mailbox", {}, project_id=str(project.id), choice=ADDRESS)


async def test_the_oauth_way_is_a_sign_in_choice_and_the_way_is_remembered(project, templates, monkeypatch):
    _granted(monkeypatch, scopes=None)
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    wizard, ops = project_setup.compile_setup(project.id, await project_setup.collect_requirements(project))

    assert [s.id for s in wizard.steps] == ["ask-mailbox-one-of", "ask-mailbox-GMAIL_ADDRESS", "store-mailbox"], "the way first"
    choices = ops["ask-mailbox-one-of"].exe_data.choices
    assert [(c.value, c.provider, c.scopes, c.command) for c in choices] == [
        (GOOGLE, "google", [MAIL], ""), (APP_PASSWORD, "", [], ""),
    ]
    assert not ops["ask-mailbox-one-of"].exe_data.auto_continue, "the screen answers once the person signed in"
    assert "--from-inputs" in ops["store-mailbox"].exe_data.command_for("darwin")


async def test_the_answer_names_the_way_even_when_nothing_is_stored():
    def env(answer) -> dict:
        return input_env({input_name("mailbox", ONE_OF_INPUT): answer})

    assert from_inputs("mailbox", env(GOOGLE)) == ({}, GOOGLE)
    assert from_inputs("mailbox", env(f"{APP_PASSWORD}=abcd")) == ({APP_PASSWORD: "abcd"}, "")
    assert from_inputs("mailbox", env({})) == ({}, "")


async def test_the_source_is_handed_the_chosen_way(project, templates, monkeypatch):
    from types import SimpleNamespace

    from flow_sdk.builtin.credential import Credential, write_setup_choice
    from flow_sdk.core.oauth import provider_registry
    from flow_sdk.ingest import credentials as resolver
    from flow_sdk.schema.data_spec.data_driver_spec import AuthSpec

    async def token_for(provider, **_kw):
        return "ya29.token" if provider == "google" else None

    async def owner(_row):
        return project

    async def identity(_provider, _token):
        return "me@gmail.com"

    monkeypatch.setattr(provider_registry, "token_for", token_for)
    monkeypatch.setattr(resolver, "owner_project", owner)
    monkeypatch.setattr(resolver, "_identity", identity)
    spec = await save_credential(manifest=mail(), scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {ADDRESS: "me@gmail.com", APP_PASSWORD: "abcd"})
    auth = AuthSpec(credential="mailbox", vars={ADDRESS: ADDRESS, APP_PASSWORD: APP_PASSWORD})
    row = SimpleNamespace(secret_store=None, deployment_id="")

    unchosen = await resolver.resolve_credentials(auth, row)
    assert (unchosen.choice, unchosen.token) == (APP_PASSWORD, None), "a stored value before a grant"

    await write_setup_choice(await Credential.get("mailbox", project), GOOGLE)
    google = await resolver.resolve_credentials(auth, row)
    assert google.choice == GOOGLE and google.token.get_secret_value() == "ya29.token"
    assert google.value(ADDRESS) == "me@gmail.com", "a MUST value always rides along"
    assert google.identity == "me@gmail.com", "the sign-in says who signed in"


# ── a way of several values ──────────────────────────────────────────────────


def paired() -> dict:
    """Gmail's shape: a Google sign-in, OR an address with its app password — given together."""
    return {
        "name": "mailbox", "setup": "Sign in with Google, or an address and an app password.",
        "vars": {
            GOOGLE: {"required": "ONE_OF", "way": "google", "kind": "oauth", "provider": "google", "scopes": [MAIL],
                     "secret": False},
            ADDRESS: {"required": "ONE_OF", "way": "app_password", "secret": False},
            APP_PASSWORD: {"required": "ONE_OF", "way": "app_password"},
        },
    }


async def test_a_way_is_its_members_and_a_sign_in_is_alone_in_its_way():
    from flow_sdk.schema.data_spec.credential_status_spec import ways

    spec = CredentialSpec.model_validate({**paired(), "schema": 2})
    assert ways(spec.vars) == {"google": [GOOGLE], "app_password": [ADDRESS, APP_PASSWORD]}
    with pytest.raises(ValidationError, match="at least two ONE_OF ways"):
        _spec({"A": {"required": "ONE_OF", "way": "w"}, "B": {"required": "ONE_OF", "way": "w"}})
    with pytest.raises(ValidationError, match="alone in its way"):
        _spec({**paired()["vars"], GOOGLE: {**paired()["vars"][GOOGLE], "way": "app_password"}})
    with pytest.raises(ValidationError, match="belongs to a ONE_OF"):
        _spec({"A": {"way": "w"}})


async def test_a_way_of_several_values_is_asked_first_as_one_choice_with_a_field_each(project, templates, monkeypatch):
    _granted(monkeypatch, scopes=None)
    await save_credential(manifest=paired(), scope="project", project_id=project.id)
    wizard, ops = project_setup.compile_setup(project.id, await project_setup.collect_requirements(project))

    assert [s.id for s in wizard.steps] == ["ask-mailbox-one-of", "store-mailbox"], "no MUST left to ask alone"
    google, app_password = ops["ask-mailbox-one-of"].exe_data.choices
    assert (google.value, google.provider, google.fields) == (GOOGLE, "google", [])
    assert app_password.value == "app_password" and [f.value for f in app_password.fields] == [ADDRESS, APP_PASSWORD]
    assert [f.secret for f in app_password.fields] == [False, True]


async def test_a_way_of_several_values_is_answered_in_lines_and_stored_as_that_way(project, templates):
    from flow_sdk.builtin.credential import Credential

    def env(answer) -> dict:
        return input_env({input_name("mailbox", ONE_OF_INPUT): answer})

    values, way = from_inputs("mailbox", env(f"{ADDRESS}=me@gmail.com\n{APP_PASSWORD}=abcd"))
    assert (values, way) == ({ADDRESS: "me@gmail.com", APP_PASSWORD: "abcd"}, "")

    await save_credential(manifest=paired(), scope="project", project_id=project.id)
    await credential_service.set_credential_by_name("mailbox", values, project_id=str(project.id))
    stored = await Credential.get("mailbox", project)
    assert stored.chosen == "app_password", "the values given name their way"
    row = next(r for r in (await credentials_status(project)).credentials if r.name == "mailbox")
    assert row.state == "connected" and row.setup_choice == "app_password"


async def test_half_a_way_does_not_hold_the_group(project, templates):
    await save_credential(manifest=paired(), scope="project", project_id=project.id)
    await credential_service.set_credential_by_name("mailbox", {ADDRESS: "me@gmail.com"}, project_id=str(project.id))
    row = next(r for r in (await credentials_status(project)).credentials if r.name == "mailbox")
    assert row.state != "connected" and APP_PASSWORD in row.missing


async def test_a_choice_stored_by_a_member_name_still_names_its_way(project, templates):
    from flow_sdk.builtin.credential import Credential, write_setup_choice

    spec = await save_credential(manifest=paired(), scope="project", project_id=project.id)
    await write_setup_choice(spec, APP_PASSWORD)
    stored = await Credential.get("mailbox", project)
    assert stored.setup_choice == "app_password" and stored.chosen == "app_password"
    assert stored.way_of(GOOGLE) == "google" and stored.is_way("google") and not stored.is_way("nope")


async def test_a_connect_wants_every_declared_sign_in_ways_scopes(project, templates, monkeypatch):
    from flow_sdk.core.oauth.wanted_scopes import _credential_way_scopes

    _granted(monkeypatch)
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    assert await _credential_way_scopes({"google"}) == {MAIL}, "unchosen: the sign-in way is open to choose"
    assert await _credential_way_scopes({"slack"}) == set()

    await credential_service.set_credential_by_name("mailbox", {}, project_id=str(project.id), choice=APP_PASSWORD)
    assert await _credential_way_scopes({"google"}) == {MAIL}, "another way chosen: connecting is how a person switches"


async def test_setting_the_credential_rechecks_the_sources_waiting_on_it(project, templates):
    """A source left in setup on this credential turns active when the credential is set — a person who closed
    Setup after storing it never reaches the source's own Verify, and the poller runs active sources only."""
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.builtin.data_source import DataSource, SourceStatus
    from flow_sdk.schema.data_spec.data_driver_spec import AuthSpec, DataDriverSpec
    from flow_sdk.sources.families import RecordSource
    from flow_sdk.sources.protocols import Verdict

    class _Waiting(RecordSource):
        provider = "one-of-waiting-test"

        async def verify(self) -> Verdict:
            return Verdict(ready=bool(self.credentials.values.get(APP_PASSWORD)), detail="needs the password")

    manifest = DataDriverSpec(schema=1, name=_Waiting.provider, auth=AuthSpec(credential="mailbox", vars={APP_PASSWORD: APP_PASSWORD}))
    DataDriver.register(DataDriver.for_class(_Waiting, manifest))
    await save_credential(manifest=mail(), scope="project", project_id=project.id)
    source = DataSource(name="waiting", provider=_Waiting.provider, project_id=str(project.id),
                        status=SourceStatus.SETUP.value)
    await source.save()

    await credential_service.set_credential_by_name("mailbox", {APP_PASSWORD: "abcd efgh"}, project_id=str(project.id))

    assert (await DataSource.get_one({"id": source.id})).status == SourceStatus.ACTIVE.value
