"""``Credential.get(name, project=None)`` and the store a credential names, as is."""
from __future__ import annotations

from pathlib import Path

import pytest

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.builtin.credential_service import save_credential
from flow_sdk.builtin.credential import CredentialAmbiguous, CredentialNotFound, Credential
from flow_sdk.builtin.credential_store import user_scope
from flow_sdk.cli.auth.secrets import read_secret
from tests.utils.deployments import make_deployment

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


def _manifest(name: str, *env_vars: str, **extra) -> dict:
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, "setup": f"Store it: `flow credentials set {name} ...`.", **extra}


async def test_the_current_projects_credential_wins_over_the_user_one(home, in_project):
    await save_credential(scope="user", manifest=_manifest("database", "DATABASE_URL"))
    declared = await save_credential(
        scope="project", project_id=str(in_project.id), manifest=_manifest("database", "DATABASE_URL")
    )

    found = await Credential.get("database")

    assert found.id == declared.id and found.scope == "project"


async def test_outside_a_project_the_user_credential_answers_unless_a_project_is_named(home, project, monkeypatch):
    user = await save_credential(scope="user", manifest=_manifest("database", "DATABASE_URL"))
    declared = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("database", "DATABASE_URL")
    )
    monkeypatch.chdir(home)

    assert (await Credential.get("database")).id == user.id
    assert (await Credential.get("database", project=project)).id == declared.id


async def test_an_undeclared_name_is_not_found(home, in_project):
    with pytest.raises(CredentialNotFound, match="stripe"):
        await Credential.get("stripe")


async def test_two_credentials_of_one_name_in_the_answering_scope_are_ambiguous(home, in_project, monkeypatch):
    twins = [Credential(id=mint_uuid(), name="stripe", scope="user") for _ in range(2)]

    async def in_scope(_project):
        return [(spec, user_scope()) for spec in twins]

    monkeypatch.setattr("flow_sdk.builtin.credential_resolver.credentials_in_scope", in_scope)

    with pytest.raises(CredentialAmbiguous) as ambiguous:
        await Credential.get("stripe")

    assert ambiguous.value.candidates == [str(spec.typeid) for spec in twins]




async def test_a_credential_names_its_store_per_deployment(home, in_project):
    from flow_sdk.schema.data_spec.deployment_secrets_spec import VAULT

    mount = Path(in_project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project", project_id=str(in_project.id), manifest=_manifest("database", "DATABASE_URL"),
    )

    assert spec.credentials.names() == ["DATABASE_URL"]
    here = await spec.secret_store()
    assert here.ref.model_dump() == {"type": "env_file", "config": {"env_file_path": str(mount / ".env.local")}}
    staging = await spec.secret_store(await make_deployment("staging"))
    assert staging.ref.config == {"env_file_path": str(mount / ".env.staging.local")}
    production = await spec.secret_store(await make_deployment("production", store=VAULT))
    assert production.ref.model_dump() == {
        "type": "vault",
        "config": {"prefix": f"credential.production.project.{in_project.id}."},
    }

    await production.save({"DATABASE_URL": "postgres://prod"})
    await production.validate_keys(spec.credentials.names())
    assert read_secret(f"credential.production.project.{in_project.id}.DATABASE_URL") == "postgres://prod"


async def test_a_form_store_choice_is_kept_by_this_computer_not_the_credential(home, in_project):
    from flow_sdk.builtin.deployment import Deployment

    spec = await save_credential(scope="user", manifest=_manifest("personal", "QA_USER"), store="vault")

    assert "value_store" not in spec.model_dump()
    assert (await Deployment.this_computer()).secrets.store_of("QA_USER").type == "vault"
    assert (await spec.secret_store()).ref.config == {"prefix": "credential.user."}


async def test_a_template_has_no_store(home):
    template = Credential(id=mint_uuid(), name="openai", scope="system")

    with pytest.raises(LookupError, match="template"):
        await template.secret_store()
