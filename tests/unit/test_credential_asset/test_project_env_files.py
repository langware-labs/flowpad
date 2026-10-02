"""A project's declared env files — more files its credentials READ, after the root ``.env.local``.

Declared in ``project_manifest.json`` (``env_files``, project-relative) so a clone reads the same
files. The root ``.env.local`` stays the one file values are written to and removed from; a
declared file is the project's own config (``backend/.env``) and is never touched.
"""
from __future__ import annotations

import json
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.assets.project_manifest import ManifestError, manifest_path, read_env_files, set_env_files
from flow_sdk.builtin.credential_resolver import resolve_project_secrets
from flow_sdk.builtin.credential_service import delete_credential, save_credential, set_credential_values
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.schema.data_spec.project_manifest_spec import ProjectManifestSpec
from flow_sdk.secrets import SecretStore

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


def _manifest(name: str, *env_vars: str) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, "setup": f"`flow credentials set {name} --stdin`."}


def _fallback(status, extra_path):
    project_file = next(f for f in status.files if f.scope == "project")
    return next(f for f in project_file.fallbacks if f.extra_path == extra_path)


def _row(status, typeid):
    return next(r for r in status.credentials if r.typeid == typeid)


@pytest.fixture
def mount(project) -> Path:
    root = Path(project.fs_storage_mount_path)
    (root / ".gitignore").write_text(".env.local\n")
    (root / "backend").mkdir()
    return root


# ── the declaration ─────────────────────────────────────────────────────────


async def test_the_root_env_local_is_the_default_and_the_only_file_without_a_declaration(home, project, mount):
    status = await credentials_status(project)

    files = [f for f in status.files if f.scope == "project"]
    assert [(f.path, f.fallbacks) for f in files] == [(str(mount / ".env.local"), [])]


async def test_declared_files_travel_in_the_project_manifest(home, project, mount):
    set_env_files(mount, ["backend/.env", "./frontend/.env.local", "backend/.env"])

    document = json.loads(manifest_path(mount).read_text())
    assert document["env_files"] == ["backend/.env", "frontend/.env.local"], "normalized, deduped"
    assert read_env_files(mount) == ["backend/.env", "frontend/.env.local"]


@pytest.mark.parametrize("bad", ["/etc/passwd", "../other/.env", "C:/x/.env", "", ".env.local"])
async def test_a_path_outside_the_project_is_refused_and_nothing_is_written(home, project, mount, bad):
    with pytest.raises(ManifestError):
        set_env_files(mount, ["backend/.env", bad])

    assert not manifest_path(mount).exists()


async def test_clearing_never_creates_a_manifest_and_an_empty_list_is_silent(home, project, mount):
    set_env_files(mount, [])
    assert not manifest_path(mount).exists()

    set_env_files(mount, ["backend/.env"])
    set_env_files(mount, [])
    assert "env_files" not in json.loads(manifest_path(mount).read_text()), "an older desk refuses an unknown key"


async def test_a_hand_edited_bad_entry_drops_alone(home, project, mount):
    spec = ProjectManifestSpec.model_validate({"env_files": ["backend/.env", "../escape", 7, "/abs"]})

    assert spec.env_files == ["backend/.env"]


async def test_the_project_action_writes_and_refuses(home, project, mount):
    ok = await project.set_env_files_action(paths=["backend/.env"])
    assert ok.data == {"env_files": ["backend/.env"]}

    refused = await project.set_env_files_action(paths=["../x"])
    assert refused.status_code == 400
    assert read_env_files(mount) == ["backend/.env"], "a refused write leaves the declaration as it was"


# ── taken into account: status, injection, the default store ────────────────


async def test_a_value_in_a_declared_file_connects_and_injects(home, project, mount):
    (mount / "backend" / ".env").write_text('QA_BACK="from-backend"\n')
    set_env_files(mount, ["backend/.env"])
    spec = await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("svc", "QA_BACK"))

    status = await credentials_status(project)
    row = _row(status, str(spec.typeid))
    assert row.state == "connected" and row.vars[0].found_in == "env"
    extra = _fallback(status, "backend/.env")
    assert extra.exists and [k.key for k in extra.detected] == ["QA_BACK"]

    resolved = await resolve_project_secrets(project)
    assert resolved["QA_BACK"].get_secret_value() == "from-backend"


async def test_the_root_file_wins_then_declared_files_in_order(home, project, mount):
    (mount / ".env.local").write_text('QA_A="root"\n')
    (mount / "backend" / ".env").write_text('QA_A="backend"\nQA_B="backend"\n')
    (mount / "second.env").write_text('QA_B="second"\nQA_C="second"\n')
    set_env_files(mount, ["backend/.env", "second.env"])
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("svc", "QA_A", "QA_B", "QA_C"))

    resolved = {k: v.get_secret_value() for k, v in (await resolve_project_secrets(project)).items()}

    assert resolved == {"QA_A": "root", "QA_B": "backend", "QA_C": "second"}


async def test_a_missing_declared_file_is_listed_and_holds_nothing(home, project, mount):
    set_env_files(mount, ["backend/.env"])

    status = await credentials_status(project)

    extra = _fallback(status, "backend/.env")
    assert (extra.path, extra.exists, extra.detected) == (str(mount / "backend" / ".env"), False, [])


async def test_a_named_environment_never_falls_back_to_development_files(home, project, mount):
    from flow_sdk.builtin.credential_store import project_scope

    set_env_files(mount, ["backend/.env"])
    scope = project_scope(project)

    assert [declared for _, declared in scope.env_files("staging")] == [None]
    assert scope.env_file_ref("staging").config == {"env_file_path": str(mount / ".env.staging.local")}


async def test_the_default_secret_store_reads_the_declared_files_too(home, project, mount, monkeypatch):
    from flow_sdk import context

    (mount / "backend" / ".env").write_text('QA_BACK="b"\n')
    set_env_files(mount, ["backend/.env"])

    async def current_project():
        return project

    monkeypatch.setattr(context, "current_project", current_project)
    store = await SecretStore.get()

    assert (await store.load(["QA_BACK"]))["QA_BACK"].get_secret_value() == "b"
    assert "QA_BACK" in await store.names()


# ── never written, never forgotten from ─────────────────────────────────────


async def test_values_are_written_to_the_root_file_only(home, project, mount):
    (mount / "backend" / ".env").write_text('QA_BACK="old"\n')
    before = (mount / "backend" / ".env").read_bytes()
    set_env_files(mount, ["backend/.env"])
    spec = await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("svc", "QA_BACK"))

    await set_credential_values(str(spec.typeid), {"QA_BACK": "new"})

    assert (mount / "backend" / ".env").read_bytes() == before
    assert dotenv_values(mount / ".env.local") == {"QA_BACK": "new"}
    resolved = await resolve_project_secrets(project)
    assert resolved["QA_BACK"].get_secret_value() == "new", "the written root file wins over the declared one"


async def test_deleting_a_credential_leaves_a_declared_file_alone(home, project, mount):
    (mount / "backend" / ".env").write_text('QA_BACK="keep"\nOTHER="x"\n')
    before = (mount / "backend" / ".env").read_bytes()
    set_env_files(mount, ["backend/.env"])
    spec = await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("svc", "QA_BACK"))

    await delete_credential(str(spec.typeid))

    assert (mount / "backend" / ".env").read_bytes() == before


async def test_a_declared_file_a_symlink_takes_out_of_the_project_is_not_read(home, project, mount, tmp_path):
    outside = tmp_path / "outside.env"
    outside.write_text('QA_OUT="leak"\n')
    (mount / "backend" / ".env").symlink_to(outside)
    set_env_files(mount, ["backend/.env"])

    status = await credentials_status(project)

    assert next(f for f in status.files if f.scope == "project").fallbacks == []
