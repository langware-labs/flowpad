"""``ONE_OF``: a credential's either-or group, and the ``cli`` variable that can be one of its ways.

Spora's Google access is the case: a service-account key file OR a gcloud sign-in — either is enough,
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

    assert from_inputs("google-cloud", env(f"{KEY}={SA_KEY}")) == {KEY: SA_KEY}
    assert from_inputs("google-cloud", env({})) == {}, "closed by a sign-in: nothing to store"
