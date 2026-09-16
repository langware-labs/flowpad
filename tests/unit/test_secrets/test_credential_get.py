"""``SecretPack.get(name, project=None)`` and the store a credential names, as is."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.secret_pack import CredentialAmbiguous, CredentialNotFound, SecretPack
from flow_sdk.builtin.credential_store import user_scope
from flow_sdk.cli.auth.secrets import read_secret

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _manifest(name: str, *env_vars: str, **extra) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, **extra}


async def test_the_current_projects_credential_wins_over_the_user_one(home, in_project):
    await save_credential(scope="user", manifest=_manifest("database", "DATABASE_URL"))
    declared = await save_credential(
        scope="project", project_id=str(in_project.id), manifest=_manifest("database", "DATABASE_URL")
    )

    found = await SecretPack.get("database")

    assert found.id == declared.id and found.scope == "project"


async def test_outside_a_project_the_user_credential_answers_unless_a_project_is_named(home, project, monkeypatch):
    user = await save_credential(scope="user", manifest=_manifest("database", "DATABASE_URL"))
    declared = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("database", "DATABASE_URL")
    )
    monkeypatch.chdir(home)

    assert (await SecretPack.get("database")).id == user.id
    assert (await SecretPack.get("database", project=project)).id == declared.id


async def test_an_undeclared_name_is_not_found(home, in_project):
    with pytest.raises(CredentialNotFound, match="stripe"):
        await SecretPack.get("stripe")


async def test_two_credentials_of_one_name_in_the_answering_scope_are_ambiguous(home, in_project, monkeypatch):
    twins = [SecretPack(id=mint_uuid(), name="stripe", scope="user") for _ in range(2)]

    async def in_scope(_project):
        return [(spec, user_scope()) for spec in twins]

    monkeypatch.setattr("flow_sdk.builtin.credential_resolver.credentials_in_scope", in_scope)

    with pytest.raises(CredentialAmbiguous) as ambiguous:
        await SecretPack.get("stripe")

    assert ambiguous.value.candidates == [str(spec.typeid) for spec in twins]


async def test_a_credential_names_its_store_per_environment(home, in_project):
    mount = Path(in_project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project",
        project_id=str(in_project.id),
        manifest=_manifest("database", "DATABASE_URL", environments={"production": {"value_store": "vault"}}),
    )

    assert spec.credentials.names() == ["DATABASE_URL"]
    development = await spec.secret_store()
    assert development.ref.model_dump() == {"type": "env_file", "config": {"env_file_path": str(mount / ".env.local")}}
    staging = await spec.secret_store("staging")
    assert staging.ref.config == {"env_file_path": str(mount / ".env.staging.local")}
    production = await spec.secret_store("production")
    assert production.ref.model_dump() == {
        "type": "vault",
        "config": {"prefix": f"credential.production.project.{in_project.id}."},
    }

    await production.save({"DATABASE_URL": "postgres://prod"})
    await production.validate_keys(spec.credentials.names())
    assert read_secret(f"credential.production.project.{in_project.id}.DATABASE_URL") == "postgres://prod"


async def test_env_file_is_accepted_as_the_env_store_spelling(home, in_project):
    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER", value_store="env_file"))

    assert spec.value_store == "env"
    assert (await spec.secret_store()).ref.config == {"env_file_path": str(home / ".env.local")}


async def test_a_template_has_no_store(home):
    template = SecretPack(id=mint_uuid(), name="openai", scope="system")

    with pytest.raises(LookupError, match="template"):
        await template.secret_store()
