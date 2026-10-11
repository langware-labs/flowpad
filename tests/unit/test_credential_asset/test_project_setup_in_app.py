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



async def _the_one_question(project) -> "ask.Question":
    """The setup's single open question — or a failure that says what the run did instead.

    A run that asks nothing leaves only "got 0" behind, which cannot tell a run that is
    still working from one that had nothing to do or one that raised. So a miss reports
    the requirements still to do and the run's own live state.
    """
    for _ in range(200):
        if open_questions():
            break
        await asyncio.sleep(0.01)
    questions = open_questions()
    if len(questions) != 1:
        to_do = [r.name for r in await project_setup.collect_requirements(project) if project_setup.to_do(r)]
        pytest.fail(
            f"expected one open question, got {len(questions)}; "
            f"requirements still to do: {to_do}; run: {project_setup.setup_run(str(project.id))}"
        )
    return questions[0]

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


async def test_skipping_locally_marks_the_record_here_and_never_the_file(project, templates):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)

    await project_setup.skip_requirement(project, str(spec.typeid), scope="local", note="not on this laptop")

    readiness = await project_setup.readiness_of(project)
    assert readiness.ready is True and readiness.to_do == []
    (skipped,) = readiness.skipped
    assert skipped.typeid == str(spec.typeid) and skipped.required and skipped.skipped.note == "not on this laptop"
    written = json.loads((Path(spec.asset_ref) / "credential.json").read_text())
    assert written["vars"]["GOOGLE_APPLICATION_CREDENTIALS"].get("required", "MUST") == "MUST", "the declaration is untouched"
    assert "setup_skipped" not in json.dumps(written), "a skip is this machine's, never the file's"


async def test_a_local_skip_survives_every_other_save_of_the_record(project, templates):
    from flow_sdk.builtin.credential import Credential

    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    await project_setup.skip_requirement(project, str(spec.typeid), scope="local")

    # A copy that knows nothing of the mark (the indexer re-reading the file, an edit).
    stale = (await Credential.get_by_id(str(spec.id))).model_copy(update={"setup_skipped": None})
    with pytest.raises(AttributeError, match="write_setup_skip"):
        stale.setup_skipped = None  # and nobody writes it but the skip
    stale.description = "edited"
    await stale.save()

    kept = await Credential.get_by_id(str(spec.id))
    assert kept.setup_skipped is not None and kept.description == "edited"


async def test_unskipping_puts_it_back(project, templates):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    await project_setup.skip_requirement(project, str(spec.typeid), scope="local")

    await project_setup.unskip_requirement(project, str(spec.typeid))

    readiness = await project_setup.readiness_of(project)
    assert readiness.ready is False and [r.typeid for r in readiness.to_do] == [str(spec.typeid)]
    assert readiness.skipped == []


async def test_skipping_always_removes_the_asset_and_stages_it_in_git(project, templates):
    import subprocess

    root = Path(project.fs_storage_mount_path)
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    folder = Path(spec.asset_ref)
    subprocess.run(["git", "init", "-q", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(["git", "-C", str(root), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"],
                   check=True)

    await project_setup.skip_requirement(project, str(spec.typeid), scope="always")

    from flow_sdk.builtin.credential import Credential

    assert not folder.exists() and await Credential.get_by_id(str(spec.id)) is None
    staged = subprocess.run(["git", "-C", str(root), "diff", "--cached", "--name-status"], capture_output=True,
                            text=True, check=True).stdout
    assert "D\t" in staged and "credential.json" in staged, staged
    log = subprocess.run(["git", "-C", str(root), "log", "--oneline"], capture_output=True, text=True).stdout
    assert len(log.splitlines()) == 1, "staged, never committed"
    assert (await project_setup.readiness_of(project)).ready is True


async def test_always_is_refused_for_what_is_not_this_projects_own(project, templates, monkeypatch):
    from flow_sdk.builtin.data_source import DataSource

    rows = [DataSource(name="telegram source", provider="telegram")]

    async def of_project(_project):
        return rows

    monkeypatch.setattr(project_setup, "project_sources", of_project)
    reqs = {r.name: r for r in await project_setup.collect_requirements(project)}
    telegram = reqs["telegram"]
    assert not telegram.declared and not telegram.can_skip_always and "template" in telegram.why_not_always

    with pytest.raises(project_setup.SkipRefused, match="template"):
        await project_setup.skip_requirement(project, telegram.typeid, scope="always")
    assert (await credential_service.template_named("telegram")) is not None, "the shipped template is untouched"


async def test_an_optional_credential_is_listed_and_never_counted(project, templates):
    hue = await save_credential(
        manifest={"name": "hue", "setup": "x", "vars": {"HUE_TOKEN": {"required": "OPTIONAL"}}},
        scope="project", project_id=project.id,
    )
    readiness = await project_setup.readiness_of(project)
    assert readiness.ready is True and readiness.to_do == []
    (optional,) = readiness.optional
    assert optional.typeid == str(hue.typeid) and not optional.required
    assert [v.env_var for v in optional.missing] == ["HUE_TOKEN"]


async def test_every_listed_requirement_is_a_record(project, templates):
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.schema.data_spec.project_manifest_spec import split_typeid

    await save_credential(manifest=GCP, scope="project", project_id=project.id)
    for req in await project_setup.collect_requirements(project):
        if req.kind == "pack":
            assert await Credential.get_by_id(split_typeid(req.typeid)[1]) is not None, req.name


async def test_skipping_something_setup_does_not_list_is_refused(project, templates):
    with pytest.raises(project_setup.SkipRefused):
        await project_setup.skip_requirement(project, "credential-00000000-0000-4000-8000-000000000000")


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
        question = await _the_one_question(project)
        assert question.to_payload()["assist_available"] is True
        assert question.setup_timeout == SETUP_TIMEOUT
    finally:
        project_setup._RUNS.pop((str(project.id), "")).cancel()


async def test_the_setup_asks_in_the_app_with_a_file_block_for_a_file_value(project, templates, served_here):
    await save_credential(manifest=GCP, scope="project", project_id=project.id)

    address = await project_setup.start_setup(project, ai=False)
    try:
        question = await _the_one_question(project)
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
        project_setup._RUNS.pop((str(project.id), "")).cancel()


async def test_a_local_skip_never_rewrites_the_asset_file(project, templates):
    spec = await save_credential(manifest=GCP, scope="project", project_id=project.id)
    manifest = Path(spec.asset_ref) / "credential.json"
    manifest.write_text('{"schema": 2, "name": "google-cloud", "vars": {"GOOGLE_APPLICATION_CREDENTIALS": {"kind": "file", "required": "MUST"}}}')
    before = manifest.read_bytes()

    await project_setup.skip_requirement(project, str(spec.typeid), scope="local")
    await project_setup.unskip_requirement(project, str(spec.typeid))

    assert manifest.read_bytes() == before, "a skip is a row change: the file is byte for byte as authored"
