"""Credential environments: one declaration, a value per environment.

An environment is a Deployment's ``environment``; ``development`` is this
computer and keeps the original locations (``.env.local``,
``credential.project.<pid>.VAR``). A named environment reads its own env file
(``.env.<env>.local``) and its own vault names. A process's environment is its
Deployment's, else the instance default, else ``development``.
"""
from __future__ import annotations

import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_resolver import environment_for, known_environments, resolve_project_secrets
from flow_sdk.builtin.credential_service import (
    CredentialError,
    delete_credential,
    save_credential,
    set_credential_values,
)
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.builtin.deployment import KIND_AGENT, Deployment
from flow_sdk.builtin.project import Project
from flow_sdk.cli.auth.secrets import get_secrets, read_secret
from flow_sdk.instance_settings import environment as environment_settings
from flow_sdk.schema.data_spec.credential_contract import (
    env_file_name,
    is_valid_environment,
    normalize_environment,
    vault_name,
)
from flow_sdk.schema.data_spec.credential_spec import CredentialSpec

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


@pytest.fixture(autouse=True)
def _clear_default_environment():
    environment_settings.reset_cache()
    yield
    environment_settings.reset_cache()


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


async def _deployment(environment: str, name: str = "qa") -> Deployment:
    row = Deployment(
        name=f"{name} ({environment})",
        kind=KIND_AGENT,
        parent_type_id="agent-7b0f6c1e-3d2a-4f5b-9c8d-1e2f3a4b5c6d",
        target={"provider": "e2b", "scope": "machine", "location": "sandbox"},
        environment=environment,
    )
    await row.save()
    return row


# ── the contract ───────────────────────────────────────────────────────────


def test_development_keeps_the_original_locations():
    assert env_file_name() == ".env.local"
    assert vault_name(scope="project", project_id="p1", env_var="K") == "credential.project.p1.K"
    assert vault_name(scope="user", project_id=None, env_var="K") == "credential.user.K"
    assert vault_name(scope="user", project_id=None, env_var="K", lm_provider="openrouter") == "lm_api.openrouter"


def test_a_named_environment_has_its_own_file_and_vault_names():
    assert env_file_name("production") == ".env.production.local"
    assert vault_name(scope="project", project_id="p1", env_var="K", environment="production") == (
        "credential.production.project.p1.K"
    )
    assert vault_name(scope="user", project_id=None, env_var="K", environment="staging") == "credential.staging.user.K"
    with pytest.raises(ValueError):
        vault_name(scope="user", project_id=None, env_var="K", lm_provider="openrouter", environment="production")


@pytest.mark.parametrize("name", ["", "Production", "prod env", "1prod", "project", "user", "x" * 41])
def test_invalid_environment_names_are_refused(name):
    assert not is_valid_environment(name)
    if name:
        with pytest.raises(ValueError):
            normalize_environment(name)
    else:
        assert normalize_environment(name) == "development"


# ── the manifest ───────────────────────────────────────────────────────────


def test_an_environment_overrides_the_store_and_the_required_set():
    parsed = CredentialSpec.model_validate(
        {
            "schema": 2,
            **_manifest("db", "DATABASE_URL", "SENTRY_DSN"),
            "environments": {"production": {"value_store": "vault", "required": ["DATABASE_URL", "SENTRY_DSN"]}},
        }
    )
    assert parsed.value_store == "env"
    assert parsed.environments["production"].value_store == "vault"


def test_an_environment_cannot_require_an_undeclared_variable():
    with pytest.raises(ValueError, match="undeclared"):
        CredentialSpec.model_validate(
            {"schema": 2, **_manifest("db", "DATABASE_URL"), "environments": {"production": {"required": ["NOPE"]}}}
        )


def test_an_llm_provider_key_has_no_environments():
    with pytest.raises(ValueError, match="no environments"):
        CredentialSpec.model_validate(
            {
                "schema": 2,
                **_manifest("openrouter", "OPENROUTER_API_KEY"),
                "lm_provider": "openrouter",
                "environments": {"production": {}},
            }
        )


# ── values per environment ─────────────────────────────────────────────────


async def test_a_production_value_lands_in_its_own_gitignored_file(home, project):
    mount = Path(project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("db", "DATABASE_URL"),
        values={"DATABASE_URL": "postgres://localhost/dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "postgres://hosted/prod"}, "production")

    assert dict(dotenv_values(mount / ".env.local")) == {"DATABASE_URL": "postgres://localhost/dev"}
    assert dict(dotenv_values(mount / ".env.production.local")) == {"DATABASE_URL": "postgres://hosted/prod"}
    ignored = (mount / ".gitignore").read_text().splitlines()
    assert ".env.local" in ignored and ".env.production.local" in ignored

    dev = await resolve_project_secrets(project)
    prod = await resolve_project_secrets(project, environment="production")
    assert dev["DATABASE_URL"].get_secret_value() == "postgres://localhost/dev"
    assert prod["DATABASE_URL"].get_secret_value() == "postgres://hosted/prod"


async def test_a_vault_override_keeps_production_out_of_every_file(home, project):
    mount = Path(project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("db", "DATABASE_URL", environments={"production": {"value_store": "vault"}}),
        values={"DATABASE_URL": "dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "prod"}, "production")

    assert read_secret(f"credential.production.project.{project.id}.DATABASE_URL") == "prod"
    assert not (mount / ".env.production.local").exists()
    assert dict(dotenv_values(mount / ".env.local")) == {"DATABASE_URL": "dev"}
    assert (await resolve_project_secrets(project, environment="production"))["DATABASE_URL"].get_secret_value() == "prod"


async def test_status_reads_one_environment_and_lists_every_one(home, project):
    await _deployment("production")
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest={
            "name": "db",
            "vars": {"DATABASE_URL": {}, "SENTRY_DSN": {"required": False}},
            "environments": {"production": {"required": ["DATABASE_URL", "SENTRY_DSN"]}},
        },
        values={"DATABASE_URL": "dev"},
    )

    dev = await credentials_status(project)
    prod = await credentials_status(project, "production")

    assert dev.environments == ["development", "production"]
    assert (dev.environment, prod.environment) == ("development", "production")
    dev_row = next(r for r in dev.credentials if r.typeid == str(spec.typeid))
    prod_row = next(r for r in prod.credentials if r.typeid == str(spec.typeid))
    assert dev_row.state == "connected", "SENTRY_DSN is optional in development"
    assert prod_row.state == "missing", "production requires both, and has neither"
    assert [f.path.endswith(".env.production.local") for f in prod.files if f.scope == "project"] == [True]
    assert all(f.environment == "production" for f in prod.files)


async def test_a_named_environment_file_that_no_gitignore_lists_yet_is_writable(home, project):
    """A repo ignoring only `.env.local` must not block production: the first
    write appends `.env.production.local` and verifies with git."""
    mount = Path(project.fs_storage_mount_path)
    (mount / ".gitignore").write_text(".env.local\n")
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"))

    prod = await credentials_status(project, "production")
    project_file = next(f for f in prod.files if f.scope == "project")
    assert (project_file.blocked, project_file.block_code) == (False, None)


async def test_a_tracked_named_environment_file_stays_blocked(home, project):
    mount = Path(project.fs_storage_mount_path)
    (mount / ".env.production.local").write_text("EXISTING=1\n")
    subprocess.run(["git", "add", "-f", ".env.production.local"], cwd=mount, check=True)
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"))

    prod = await credentials_status(project, "production")
    project_file = next(f for f in prod.files if f.scope == "project")
    assert (project_file.blocked, project_file.block_code) == (True, "tracked")


async def test_known_environments_are_development_plus_every_deployment(home):
    await _deployment("staging")
    await _deployment("production", name="other")
    await _deployment("production", name="third")

    assert await known_environments() == ["development", "production", "staging"]


async def test_delete_forgets_vault_values_in_every_environment_and_keeps_file_lines(home, project):
    await _deployment("production")
    mount = Path(project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("db", "DATABASE_URL", environments={"production": {"value_store": "vault"}}),
        values={"DATABASE_URL": "dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "prod"}, "production")

    result = await delete_credential(str(spec.typeid))

    names = {row["name"] for row in get_secrets()}
    assert f"credential.production.project.{project.id}.DATABASE_URL" not in names
    assert dict(dotenv_values(mount / ".env.local")) == {"DATABASE_URL": "dev"}, "the user's file lines stay"
    assert result["kept"] == ["DATABASE_URL"]


async def test_an_invalid_environment_is_refused_before_anything_is_written(home, project):
    with pytest.raises(CredentialError, match="valid environment"):
        await save_credential(
            scope="project",
            project_id=str(project.id),
            manifest=_manifest("db", "DATABASE_URL"),
            values={"DATABASE_URL": "x"},
            environment="Prod!",
        )
    assert not (Path(project.fs_storage_mount_path) / "agentic-assets").exists()


async def test_an_llm_provider_key_cannot_take_a_named_environment_value(home):
    spec = await save_credential(
        scope="user",
        manifest=_manifest("openrouter", "OPENROUTER_API_KEY", lm_provider="openrouter"),
        values={"OPENROUTER_API_KEY": "sk-or-dev"},
    )
    with pytest.raises(CredentialError, match="hub-funded"):
        await set_credential_values(str(spec.typeid), {"OPENROUTER_API_KEY": "sk-or-prod"}, "production")


# ── which environment a process runs in ───────────────────────────────────


async def test_a_process_runs_in_its_deployments_environment(home):
    staging = await _deployment("staging")

    assert await environment_for(SimpleNamespace(deployment_id=staging.id)) == "staging"


async def test_a_process_without_a_deployment_uses_the_instance_default(home):
    with patch.object(environment_settings.app_config, "get_config", return_value="production"):
        assert await environment_for(SimpleNamespace(deployment_id=None)) == "production"
        assert await environment_for(None) == "production"


async def test_nothing_set_falls_back_to_development(home):
    with patch.object(environment_settings.app_config, "get_config", return_value=None):
        assert await environment_for(SimpleNamespace(deployment_id="missing-deployment")) == "development"


def test_an_invalid_stored_default_reads_as_development():
    with patch.object(environment_settings.app_config, "get_config", return_value="Not Valid"):
        assert environment_settings.get_default_environment() == "development"
