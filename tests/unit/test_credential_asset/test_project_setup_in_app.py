"""A project's setup, as the app runs it: readiness, the setup wizard's questions in the app, and
``file`` credential variables (a service-account key JSON), which are kept as files.

Real isolated DB, real project, real credential service. The wizard run is started the way the
``POST /project/<id>/setup`` action starts it; its first question is inspected where the app's tab
would draw it (``open_questions`` on this backend), then the run is stopped — the steps after it shell
out to ``flow`` and are proven end to end on a real instance, not here.
"""
from __future__ import annotations

import asyncio
import json
import stat
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin import credential_service, project_setup
from flow_sdk.builtin.credential_service import CredentialError, save_credential
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.core.compute_op import ask
from flow_sdk.core.compute_op.ask import open_questions
from flow_sdk.schema.data_spec.compute_op_spec import SETUP_TIMEOUT

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

SA_KEY = json.dumps({"type": "service_account", "project_id": "demo", "private_key": "-----not-a-real-key-----"})
GCP = {
    "name": "google-cloud", "setup": "Create a service account key.",
    "vars": {"GOOGLE_APPLICATION_CREDENTIALS": {"kind": "file", "pattern": '"type":\\s*"service_account"'}},
}


@pytest.fixture(autouse=True)
def _no_sources(monkeypatch):
    async def none(_project):
        return []

    monkeypatch.setattr(project_setup, "project_sources", none)


def _stored(project, name: str) -> str | None:
    """What the project's .env.local holds for ``name`` — for a file var, the file's path."""
    return dotenv_values(Path(project.fs_storage_mount_path) / ".env.local").get(name)


# ── file credential variables ────────────────────────────────────────────────


async def test_a_file_value_is_kept_as_a_private_file_and_the_variable_holds_its_path(project):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)

    await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY})

    path = Path(_stored(project, "GOOGLE_APPLICATION_CREDENTIALS"))
    assert path.read_text() == SA_KEY
    assert stat.S_IMODE(path.stat().st_mode) == 0o600, "a key file is this user's only"
    assert Path(project.fs_storage_mount_path) not in path.parents, "never inside the project tree"
    (row,) = [r for r in (await credentials_status(project)).credentials if r.name == "google-cloud"]
    assert (row.vars[0].kind, row.vars[0].present) == ("file", True)


async def test_a_file_value_can_name_a_file_to_read(project, tmp_path):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    key = tmp_path / "key.json"
    key.write_text(SA_KEY)

    await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": f"@{key}"})

    assert Path(_stored(project, "GOOGLE_APPLICATION_CREDENTIALS")).read_text() == SA_KEY


async def test_the_pattern_is_checked_against_the_files_content(project):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)

    with pytest.raises(CredentialError, match="does not look right"):
        await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": '{"type": "user"}'})


async def test_a_path_whose_file_is_gone_is_not_present(project):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY})
    Path(_stored(project, "GOOGLE_APPLICATION_CREDENTIALS")).unlink()

    (row,) = [r for r in (await credentials_status(project)).credentials if r.name == "google-cloud"]
    assert row.vars[0].present is False


async def test_deleting_the_credential_removes_its_files(project):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY})
    path = Path(_stored(project, "GOOGLE_APPLICATION_CREDENTIALS"))

    await credential_service.delete_credential(str(spec.typeid))

    assert not path.exists()


# ── readiness: MUST values only ──────────────────────────────────────────────


async def test_a_missing_must_value_makes_the_project_not_ready(project, templates):
    await save_credential(manifest=GCP, scope="project", project_id=project.id)

    readiness = await project_setup.readiness_of(project)

    assert readiness.ready is False
    assert [(r.name, [v.env_var for v in r.missing]) for r in readiness.to_do] == [
        ("google-cloud", ["GOOGLE_APPLICATION_CREDENTIALS"])
    ]


async def test_optional_values_never_block(project, templates):
    await save_credential(
        manifest={"name": "hue", "setup": "x", "vars": {"HUE_TOKEN": {"required": "OPTIONAL"}}},
        scope="project", project_id=project.id,
    )

    assert (await project_setup.readiness_of(project)).ready is True


async def test_setting_the_must_value_makes_it_ready(project, templates):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    await credential_service.set_credential_values(str(spec.typeid), {"GOOGLE_APPLICATION_CREDENTIALS": SA_KEY})

    assert (await project_setup.readiness_of(project)).ready is True


# ── the setup run the app starts ─────────────────────────────────────────────


@pytest.fixture
def served_here(monkeypatch):
    """This process is the backend a tab would draw the question from (no window is opened)."""
    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", True)


async def test_with_ai_the_question_offers_ai_assist(project, templates, served_here):
    await save_credential(manifest=GCP, scope="project", project_id=project.id)

    await project_setup.start_setup(project, ai=True)
    try:
        for _ in range(200):
            if open_questions():
                break
            await asyncio.sleep(0.01)
        (question,) = open_questions()
        assert question.to_payload()["assist_available"] is True
        assert question.setup_timeout == SETUP_TIMEOUT
    finally:
        project_setup._RUNS.pop(str(project.id)).cancel()


async def test_the_setup_asks_in_the_app_with_a_file_block_for_a_file_value(project, templates, served_here):
    await save_credential(manifest=GCP, scope="project", project_id=project.id)

    address = await project_setup.start_setup(project, ai=False)
    try:
        for _ in range(200):
            if open_questions():
                break
            await asyncio.sleep(0.01)
        (question,) = open_questions()
        payload = question.to_payload()
        assert payload["run"] == address == project_setup.setup_run_address(str(project.id)), (
            "the question names the run, so the setup screen can claim it"
        )
        assert (payload["file"], payload["secret"]) == (True, True)
        assert payload["guide"] == GCP["setup"], "the credential's guide is drawn with the question"
        assert payload["assist_available"] is False, "ai=False: no AI Assist offered"
        assert project_setup.setup_run(str(project.id))["running"] is True
        assert await project_setup.start_setup(project, ai=False) == address, "a second start joins the run"
    finally:
        project_setup._RUNS.pop(str(project.id)).cancel()
