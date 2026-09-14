"""Credentials in both scopes, in both stores — the whole matrix.

A credential is declared in a scope (``user`` = the home folder, ``project`` = a
project mount) and names a store (``env`` = the scope's ``.env.local``,
``vault`` = the encrypted per-instance store). Every combination has to put the
value in one predictable place, report it, inject it, and remove it again.
"""
from __future__ import annotations

import json
import subprocess
import uuid
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_resolver import declared_vars, resolve_project_secrets
from flow_sdk.builtin.credential_service import (
    CredentialError,
    delete_credential,
    save_credential,
    set_credential_values,
)
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.builtin.project import Project
from flow_sdk.cli.auth.secrets import get_secrets, read_secret

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


@pytest.fixture
def home(folder_db, sod_env, tmp_path, monkeypatch):
    """User scope rooted at a temp folder instead of the real home."""
    import flow_sdk.builtin.asset_placement as placement
    from flow_sdk.assets.placement import Scope

    root = tmp_path / "home"
    root.mkdir()
    real = placement.root_for_scope

    def root_for_scope(scope, *, project_mount=None):
        return root if scope == Scope.USER else real(scope, project_mount=project_mount)

    monkeypatch.setattr(placement, "root_for_scope", root_for_scope)
    return root


@pytest.fixture
async def project(home, tmp_path):
    mount = tmp_path / "proj"
    mount.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=mount, check=True)
    p = Project(name=str(mount))
    p.fs_storage_mount_path = str(mount)
    await p.save()
    return p


def _manifest(name: str, *env_vars: str, **extra) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, **extra}


def _env(root: Path) -> dict[str, str]:
    return dict(dotenv_values(root / ".env.local"))


def _vault_names() -> set[str]:
    return {row["name"] for row in get_secrets()}


def _row(status, typeid):
    return next(r for r in status.credentials if r.typeid == typeid)


# ── where a value lands, per scope × store ─────────────────────────────────


async def test_user_env_writes_the_home_env_file_without_a_gitignore(home, project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), values={"QA_USER": "u1"})

    assert _env(home) == {"QA_USER": "u1"}
    assert not (home / ".gitignore").exists(), "a home folder that is not a repo gets no .gitignore"
    assert Path(spec.asset_ref) == home / "agentic-assets" / "credential" / "personal"
    assert spec.scope == "user" and spec.project_id is None


async def test_user_vault_writes_a_user_vault_entry_and_no_file(home, project):
    await save_credential(
        scope="user", manifest=_manifest("personal", "QA_USER", value_store="vault"), values={"QA_USER": "u2"}
    )

    assert read_secret("credential.user.QA_USER") == "u2"
    assert not (home / ".env.local").exists()


async def test_project_env_writes_the_project_env_file_and_gitignores_it(home, project):
    mount = Path(project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("team", "QA_PROJ"), values={"QA_PROJ": "p1"}
    )

    assert _env(mount) == {"QA_PROJ": "p1"}
    assert ".env.local" in (mount / ".gitignore").read_text()
    assert Path(spec.asset_ref) == mount / "agentic-assets" / "credential" / "team"
    assert (spec.scope, spec.project_id) == ("project", str(project.id))


async def test_project_vault_is_scoped_to_that_project(home, project):
    await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("team", "QA_PROJ", value_store="vault"),
        values={"QA_PROJ": "p2"},
    )

    assert read_secret(f"credential.project.{project.id}.QA_PROJ") == "p2"
    assert not (Path(project.fs_storage_mount_path) / ".env.local").exists()


@pytest.mark.parametrize("scope", ["user", "project"])
@pytest.mark.parametrize("store", ["env", "vault"])
async def test_every_combination_is_connected_and_injected(home, project, scope, store):
    project_id = str(project.id) if scope == "project" else None
    spec = await save_credential(
        scope=scope, project_id=project_id, manifest=_manifest("pack", "QA_KEY", value_store=store), values={"QA_KEY": "v"}
    )

    row = _row(await credentials_status(project), str(spec.typeid))
    assert (row.scope, row.value_store, row.state) == (scope, store, "connected")
    assert row.vars[0].present and row.vars[0].found_in == store

    resolved = await resolve_project_secrets(project)
    assert resolved["QA_KEY"].get_secret_value() == "v"


async def test_the_folder_is_a_real_asset_with_a_v4_id(home, project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER", title="Personal"))

    folder = Path(spec.asset_ref)
    manifest = json.loads((folder / "credential.json").read_text())
    capsule = json.loads((folder / ".flow" / "capsules" / "identity.json").read_text())
    assert manifest["title"] == "Personal" and manifest.get("value_store", "env") == "env"
    assert "id" not in manifest
    assert capsule["data"]["id"] == str(spec.id)
    assert uuid.UUID(str(spec.id)).version == 4


# ── packing detected keys ───────────────────────────────────────────────────


async def test_detected_keys_are_listed_until_packed(home, project):
    mount = Path(project.fs_storage_mount_path)
    (mount / ".gitignore").write_text(".env.local\n")
    (mount / ".env.local").write_text('QA_A="1"\nQA_B="2"\nVITE_PORT="5173"\n')
    before = (mount / ".env.local").read_bytes()

    status = await credentials_status(project)
    file = next(f for f in status.files if f.scope == "project")
    assert [k.key for k in file.detected] == ["QA_A", "QA_B", "VITE_PORT"]

    spec = await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("pack", "QA_A", "QA_B"))

    assert (mount / ".env.local").read_bytes() == before, "packing writes no value"
    status = await credentials_status(project)
    file = next(f for f in status.files if f.scope == "project")
    assert [k.key for k in file.detected] == ["QA_A", "QA_B", "VITE_PORT"], "the file is listed whole"
    assert set(_row(status, str(spec.typeid)).model_dump()["vars"][i]["env_var"] for i in (0, 1)) == {"QA_A", "QA_B"}
    assert _row(status, str(spec.typeid)).state == "connected"
    assert set(await resolve_project_secrets(project)) == {"QA_A", "QA_B"}, "an unpacked key is never injected"


async def test_user_scope_keys_are_detected_too(home, project):
    (home / ".env.local").write_text('QA_HOME="h"\n')

    status = await credentials_status(None)

    file = next(f for f in status.files if f.scope == "user")
    assert [k.key for k in file.detected] == ["QA_HOME"]
    assert not file.blocked


# ── one variable, one owner ─────────────────────────────────────────────────


async def test_a_variable_is_declared_once_per_scope(home, project):
    await save_credential(scope="user", manifest=_manifest("one", "QA_DUP"))

    with pytest.raises(CredentialError, match="QA_DUP is already declared by one"):
        await save_credential(scope="user", manifest=_manifest("two", "QA_DUP"))


async def test_a_project_declaration_overrides_the_user_one(home, project):
    user = await save_credential(scope="user", manifest=_manifest("mine", "QA_SHARED"), values={"QA_SHARED": "user"})
    proj = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("team", "QA_SHARED"), values={"QA_SHARED": "proj"}
    )

    assert (await resolve_project_secrets(project))["QA_SHARED"].get_secret_value() == "proj"
    assert (await resolve_project_secrets(None))["QA_SHARED"].get_secret_value() == "user"
    status = await credentials_status(project)
    assert _row(status, str(user.typeid)).vars[0].shadowed_by == str(proj.typeid)
    assert _row(status, str(proj.typeid)).vars[0].shadowed_by is None
    assert (await declared_vars(project))["QA_SHARED"].scope.scope == "project"


async def test_a_project_does_not_see_another_projects_credentials(home, project, tmp_path):
    other_mount = tmp_path / "other"
    other_mount.mkdir()
    other = Project(name=str(other_mount))
    other.fs_storage_mount_path = str(other_mount)
    await other.save()
    await save_credential(scope="project", project_id=str(other.id), manifest=_manifest("theirs", "QA_OTHER"))

    assert "QA_OTHER" not in await declared_vars(project)


# ── LLM provider keys ───────────────────────────────────────────────────────


async def test_a_provider_key_is_a_user_vault_entry_the_funding_resolver_reads(home, project):
    await save_credential(
        scope="user",
        manifest=_manifest("openrouter", "OPENROUTER_API_KEY", lm_provider="openrouter"),
        values={"OPENROUTER_API_KEY": "sk-or-test"},
    )

    assert read_secret("lm_api.openrouter") == "sk-or-test"
    assert "credential.user.OPENROUTER_API_KEY" not in _vault_names()


async def test_a_provider_key_cannot_be_added_to_a_project(home, project):
    with pytest.raises(CredentialError, match="only be added for the user"):
        await save_credential(
            scope="project",
            project_id=str(project.id),
            manifest=_manifest("openrouter", "OPENROUTER_API_KEY", lm_provider="openrouter"),
        )


# ── refusals leave nothing behind ───────────────────────────────────────────


async def test_a_committable_env_file_blocks_the_save_and_creates_no_folder(home, project):
    mount = Path(project.fs_storage_mount_path)
    (mount / ".env.local").write_text('ALREADY="x"\n')
    subprocess.run(["git", "add", "-f", ".env.local"], cwd=mount, check=True)

    with pytest.raises(CredentialError) as excinfo:
        await save_credential(
            scope="project", project_id=str(project.id), manifest=_manifest("team", "QA_PROJ"), values={"QA_PROJ": "p"}
        )

    assert excinfo.value.code == "tracked"
    assert not (mount / "agentic-assets").exists()
    assert "QA_PROJ" not in (mount / ".env.local").read_text()


async def test_a_disabled_vault_blocks_the_save_and_creates_no_folder(home, project, monkeypatch):
    monkeypatch.setattr("flow_sdk.cli.auth.secrets.is_secrets_enabled", lambda: False)

    with pytest.raises(CredentialError) as excinfo:
        await save_credential(
            scope="user", manifest=_manifest("personal", "QA_USER", value_store="vault"), values={"QA_USER": "u"}
        )

    assert excinfo.value.code == "vault-disabled"
    assert not (home / "agentic-assets").exists()


async def test_a_value_for_an_undeclared_variable_is_refused(home, project):
    with pytest.raises(CredentialError, match="not a variable"):
        await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), values={"OTHER": "x"})


@pytest.mark.parametrize(
    "manifest, message",
    [
        ({"name": "bad name", "vars": {"A": {}}}, "not a valid credential name"),
        ({"name": "novars", "vars": {}}, "at least one variable"),
        ({"name": "badvar", "vars": {"1X": {}}}, "not a valid environment variable name"),
    ],
)
async def test_an_invalid_manifest_is_refused(home, project, manifest, message):
    with pytest.raises(CredentialError, match=message):
        await save_credential(scope="user", manifest=manifest)


# ── rotate, edit, delete ────────────────────────────────────────────────────


async def test_rotating_a_value_keeps_the_location(home, project):
    spec = await save_credential(
        scope="user", manifest=_manifest("personal", "QA_USER", value_store="vault"), values={"QA_USER": "old"}
    )
    names_before = _vault_names()

    await set_credential_values(str(spec.typeid), {"QA_USER": "new", })

    assert read_secret("credential.user.QA_USER") == "new"
    assert _vault_names() == names_before


async def test_an_empty_value_is_skipped_not_cleared(home, project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), values={"QA_USER": "keep"})

    await set_credential_values(str(spec.typeid), {"QA_USER": ""})

    assert _env(home) == {"QA_USER": "keep"}


async def test_editing_keeps_the_id_and_rewrites_the_manifest(home, project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"))

    edited = await save_credential(
        typeid=str(spec.typeid), manifest=_manifest("ignored", "QA_USER", "QA_EXTRA", title="Renamed")
    )

    assert edited.id == spec.id and edited.name == "personal"
    written = json.loads((Path(spec.asset_ref) / "credential.json").read_text())
    assert written["title"] == "Renamed"
    assert sorted(written["vars"]) == ["QA_EXTRA", "QA_USER"]


async def test_deleting_a_vault_credential_removes_values_and_folder(home, project):
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("team", "QA_PROJ", value_store="vault"),
        values={"QA_PROJ": "p"},
    )

    result = await delete_credential(str(spec.typeid))

    assert result == {"deleted": ["QA_PROJ"], "kept": []}
    assert read_secret(f"credential.project.{project.id}.QA_PROJ") is None
    assert not Path(spec.asset_ref).exists()
    assert "QA_PROJ" not in await declared_vars(project)


async def test_deleting_an_env_credential_keeps_the_users_lines(home, project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), values={"QA_USER": "u"})

    result = await delete_credential(str(spec.typeid))

    assert result == {"deleted": [], "kept": ["QA_USER"]}
    assert _env(home) == {"QA_USER": "u"}
    assert not Path(spec.asset_ref).exists()
    status = await credentials_status(None)
    assert len(next(f for f in status.files if f.scope == "user").detected) == 1


async def test_deleting_one_project_credential_leaves_another_projects_value(home, project, tmp_path):
    other_mount = tmp_path / "other"
    other_mount.mkdir()
    other = Project(name=str(other_mount))
    other.fs_storage_mount_path = str(other_mount)
    await other.save()
    mine = await save_credential(
        scope="project", project_id=str(project.id),
        manifest=_manifest("team", "QA_SAME", value_store="vault"), values={"QA_SAME": "mine"},
    )
    await save_credential(
        scope="project", project_id=str(other.id),
        manifest=_manifest("team", "QA_SAME", value_store="vault"), values={"QA_SAME": "theirs"},
    )

    await delete_credential(str(mine.typeid))

    assert read_secret(f"credential.project.{other.id}.QA_SAME") == "theirs"


async def test_a_catalogue_template_is_read_only(home, project):
    from flow_sdk.builtin.credential_spec import CredentialSpec

    template = CredentialSpec(name="gmail", vars={"GMAIL_ADDRESS": {"label": "x"}})
    template.scope = "system"
    await template.save()

    with pytest.raises(CredentialError, match="template"):
        await save_credential(typeid=str(template.typeid), manifest=_manifest("gmail", "GMAIL_ADDRESS"))
    with pytest.raises(CredentialError, match="template"):
        await delete_credential(str(template.typeid))
    assert "GMAIL_ADDRESS" not in await declared_vars(project), "a template is never a declaration"


# ── reporting a value in the wrong place ────────────────────────────────────


async def test_a_value_in_the_other_store_is_reported_as_wrong_store(home, project):
    (home / ".env.local").write_text('QA_USER="in-the-file"\n')
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER", value_store="vault"))

    var = _row(await credentials_status(None), str(spec.typeid)).vars[0]

    assert (var.present, var.found_in, var.warning) == (False, "env", "wrong-store")
    assert "QA_USER" not in await resolve_project_secrets(None)


async def test_status_never_carries_a_value(home, project):
    await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), values={"QA_USER": "sk-leak-probe"})

    blob = json.dumps((await credentials_status(project)).model_dump(mode="json"))

    assert "sk-leak-probe" not in blob
