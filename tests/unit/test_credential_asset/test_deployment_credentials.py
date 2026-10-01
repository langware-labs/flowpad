"""Where credential values live is a Deployment's: its store, per-variable exceptions, extra requirements.

A credential says WHAT (``CredentialSpec``); each Deployment says WHERE (``DeploymentSecretsSpec``). This
computer is one Deployment (``Deployment.this_computer()``) whose binding every process without a
deployment of its own reads — and an agent's local deployment inherits. A local store is completed per
scope and the deployment's ``environment``: ``development`` keeps the original locations (``.env.local``,
``credential.project.<pid>.VAR``), a named environment its own file (``.env.<env>.local``) and vault
names. A ``credential.json`` written before 0.2.178 still says where; the boot lift moves it.
"""
from __future__ import annotations

import asyncio
import json
import subprocess
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_resolver import known_deployments, placement_for, resolve_project_secrets
from flow_sdk.builtin.credential_service import (
    CredentialError,
    delete_credential,
    save_credential,
    set_credential_values,
)
from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.builtin.credential_store import Placement
from flow_sdk.builtin.deployment import Deployment
from flow_sdk.builtin.project import Project
from flow_sdk.cli.auth.secrets import get_secrets, read_secret
from flow_sdk.instance_settings import environment as environment_settings
from flow_sdk.schema.data_spec.credential_contract import (
    env_file_name,
    is_valid_environment,
    normalize_environment,
    vault_name,
)
from flow_sdk.schema.data_spec.deployment_secrets_spec import VAULT
from tests.utils.deployments import make_deployment

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
    return {"name": name, "vars": {v: {"label": v} for v in env_vars}, "setup": f"Store it: `flow credentials set {name} ...`.", **extra}


_deployment = make_deployment


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



# ── values per deployment ──────────────────────────────────────────────────


async def test_a_production_value_lands_in_its_own_gitignored_file(home, project):
    mount = Path(project.fs_storage_mount_path)
    production = await _deployment("production")
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest=_manifest("db", "DATABASE_URL"),
        values={"DATABASE_URL": "postgres://localhost/dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "postgres://hosted/prod"}, str(production.id))

    assert dict(dotenv_values(mount / ".env.local")) == {"DATABASE_URL": "postgres://localhost/dev"}
    assert dict(dotenv_values(mount / ".env.production.local")) == {"DATABASE_URL": "postgres://hosted/prod"}
    ignored = (mount / ".gitignore").read_text().splitlines()
    assert ".env.local" in ignored and ".env.production.local" in ignored

    dev = await resolve_project_secrets(project)
    prod = await resolve_project_secrets(project, placement=await Placement.of(production))
    assert dev["DATABASE_URL"].get_secret_value() == "postgres://localhost/dev"
    assert prod["DATABASE_URL"].get_secret_value() == "postgres://hosted/prod"


async def test_a_vault_exception_keeps_production_out_of_every_file(home, project):
    mount = Path(project.fs_storage_mount_path)
    production = await _deployment("production", exceptions={"DATABASE_URL": VAULT})
    spec = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"), values={"DATABASE_URL": "dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "prod"}, str(production.id))

    assert read_secret(f"credential.production.project.{project.id}.DATABASE_URL") == "prod"
    assert not (mount / ".env.production.local").exists()
    assert dict(dotenv_values(mount / ".env.local")) == {"DATABASE_URL": "dev"}
    prod = await resolve_project_secrets(project, placement=await Placement.of(production))
    assert prod["DATABASE_URL"].get_secret_value() == "prod"


async def test_two_credentials_saved_at_once_both_keep_their_store(home):
    """Each save chooses a store on this computer's ONE binding. Saved concurrently (the channel doubles
    plant every driver's credential at once), the second must not write back the binding it read
    before the first wrote — that dropped the first credential's variables to the default store,
    where its values (written to the vault) were never found."""
    await Deployment.this_computer()  # exists before either save, as it does on a running instance
    saved = await asyncio.gather(*(
        save_credential(scope="user", manifest=_manifest(name, var), values={var: "v"}, store="vault")
        for name, var in (("first", "FIRST_TOKEN"), ("second", "SECOND_TOKEN"))
    ))

    here = await Deployment.this_computer()
    for spec in saved:
        assert (await spec.secret_store(here)).ref.type == "vault", spec.name


async def test_an_agents_local_deployment_reads_what_this_computer_reads(home, project):
    here = await Deployment.this_computer()
    await here.keep_in(["DATABASE_URL"], VAULT)
    local = await _deployment("development", name="agent")  # no binding of its own
    spec = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"), values={"DATABASE_URL": "v"},
    )

    assert read_secret(f"credential.project.{project.id}.DATABASE_URL") == "v"
    assert (await spec.secret_store(local)).ref.type == "vault"
    assert local.secrets is None, "inherits, never copies, until it is given its own"


async def test_status_reads_one_deployment_and_lists_every_one(home, project):
    production = await _deployment("production", require=["SENTRY_DSN"])
    spec = await save_credential(
        scope="project",
        project_id=str(project.id),
        manifest={
            "name": "db",
            "vars": {"DATABASE_URL": {}, "SENTRY_DSN": {"required": False}},
            "setup": "Store it: `flow credentials set db DATABASE_URL=...`.",
        },
        values={"DATABASE_URL": "dev"},
    )

    dev = await credentials_status(project)
    prod = await credentials_status(project, str(production.id))

    here = await Deployment.this_computer()
    assert [(d.id, d.this_computer) for d in dev.deployments] == [(str(here.id), True), (str(production.id), False)]
    assert (dev.deployment_id, dev.environment, prod.environment) == (str(here.id), "development", "production")
    dev_row = next(r for r in dev.credentials if r.typeid == str(spec.typeid))
    prod_row = next(r for r in prod.credentials if r.typeid == str(spec.typeid))
    assert dev_row.state == "connected", "SENTRY_DSN is optional on this computer"
    assert prod_row.state == "missing", "production requires both, and has neither"
    assert [v.store for v in prod_row.vars] == ["env", "env"]
    assert [f.path.endswith(".env.production.local") for f in prod.files if f.scope == "project"] == [True]
    assert all(f.environment == "production" for f in prod.files)


async def test_a_named_environment_file_that_no_gitignore_lists_yet_is_writable(home, project):
    """A repo ignoring only `.env.local` must not block production: the first
    write appends `.env.production.local` and verifies with git."""
    mount = Path(project.fs_storage_mount_path)
    (mount / ".gitignore").write_text(".env.local\n")
    production = await _deployment("production")
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"))

    prod = await credentials_status(project, str(production.id))
    project_file = next(f for f in prod.files if f.scope == "project")
    assert (project_file.blocked, project_file.block_code) == (False, None)


async def test_a_tracked_named_environment_file_stays_blocked(home, project):
    mount = Path(project.fs_storage_mount_path)
    (mount / ".env.production.local").write_text("EXISTING=1\n")
    subprocess.run(["git", "add", "-f", ".env.production.local"], cwd=mount, check=True)
    production = await _deployment("production")
    await save_credential(scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"))

    prod = await credentials_status(project, str(production.id))
    project_file = next(f for f in prod.files if f.scope == "project")
    assert (project_file.blocked, project_file.block_code) == (True, "tracked")


async def test_known_deployments_are_this_computer_then_every_other(home):
    staging = await _deployment("staging")
    production = await _deployment("production", name="other")

    rows = await known_deployments()
    assert rows[0].is_this_computer and {r.id for r in rows[1:]} == {staging.id, production.id}
    assert len([r for r in rows if r.is_this_computer]) == 1
    assert (await Deployment.this_computer()).id == rows[0].id, "found again, never minted twice"


async def test_delete_forgets_values_at_every_deployment_and_every_store(home, project):
    production = await _deployment("production", exceptions={"DATABASE_URL": VAULT})
    mount = Path(project.fs_storage_mount_path)
    spec = await save_credential(
        scope="project", project_id=str(project.id), manifest=_manifest("db", "DATABASE_URL"), values={"DATABASE_URL": "dev"},
    )
    await set_credential_values(str(spec.typeid), {"DATABASE_URL": "prod"}, str(production.id))
    (mount / ".env.staging.local").write_text("DATABASE_URL=stale\n")
    await _deployment("staging", name="other")

    result = await delete_credential(str(spec.typeid))

    names = {row["name"] for row in get_secrets()}
    assert f"credential.production.project.{project.id}.DATABASE_URL" not in names
    assert dict(dotenv_values(mount / ".env.local")) == {}
    assert dict(dotenv_values(mount / ".env.staging.local")) == {}
    assert (result.removed, result.deleted) == (True, ["DATABASE_URL"])
    assert sorted((s.type, s.deleted == ["DATABASE_URL"]) for s in result.stores) == [
        ("env_file", True), ("env_file", True), ("vault", True)
    ]


async def test_an_unknown_deployment_is_refused_before_anything_is_written(home, project):
    with pytest.raises(CredentialError, match="deployment not found"):
        await save_credential(
            scope="project",
            project_id=str(project.id),
            manifest=_manifest("db", "DATABASE_URL"),
            values={"DATABASE_URL": "x"},
            deployment_id="9b2c0f3e-1a4d-4c5b-8e6f-7a8b9c0d1e2f",
        )
    assert not (Path(project.fs_storage_mount_path) / "agentic-assets").exists()


async def test_an_llm_provider_key_cannot_take_a_named_environment_value(home):
    production = await _deployment("production")
    spec = await save_credential(
        scope="user",
        manifest=_manifest("openrouter", "OPENROUTER_API_KEY", lm_provider="openrouter"),
        values={"OPENROUTER_API_KEY": "sk-or-dev"},
    )
    with pytest.raises(CredentialError, match="hub-funded"):
        await set_credential_values(str(spec.typeid), {"OPENROUTER_API_KEY": "sk-or-prod"}, str(production.id))


# ── where a process reads ─────────────────────────────────────────────────


async def test_a_process_reads_where_its_deployment_keeps_values(home):
    staging = await _deployment("staging", exceptions={"K": VAULT})

    placement = await placement_for(SimpleNamespace(deployment_id=staging.id))
    assert (placement.environment, placement.deployment_id, placement.secrets.store_of("K").type) == (
        "staging", str(staging.id), "vault"
    )


async def test_a_process_without_a_deployment_reads_at_this_computer_in_the_instance_default(home):
    with patch.object(environment_settings.app_config, "get_config", return_value="production"):
        assert (await placement_for(SimpleNamespace(deployment_id=None))).environment == "production"
        assert (await placement_for(None)).deployment_id == str((await Deployment.this_computer()).id)


async def test_a_missing_deployment_reads_at_this_computer(home):
    with patch.object(environment_settings.app_config, "get_config", return_value=None):
        placement = await placement_for(SimpleNamespace(deployment_id="0b2c0f3e-1a4d-4c5b-8e6f-7a8b9c0d1e2f"))
        assert (placement.environment, placement.deployment_id) == ("development", str((await Deployment.this_computer()).id))


def test_an_invalid_stored_default_reads_as_development():
    with patch.object(environment_settings.app_config, "get_config", return_value="Not Valid"):
        assert environment_settings.get_default_environment() == "development"


# ── the boot lift: a pre-0.2.178 credential.json that still says where ─────


async def test_the_lift_moves_where_values_live_onto_deployments_and_runs_once(home, project):
    from flow_sdk.migrations.migration_2026_09_credential_stores import lift

    production = await _deployment("production")
    local = await _deployment("development", name="agent")
    mount = Path(project.fs_storage_mount_path)
    folder = mount / "agentic-assets" / "credential" / "db"
    folder.mkdir(parents=True)
    legacy = {
        "name": "db", "schema": 2, "setup": "x", "value_store": "vault",
        "vars": {"DATABASE_URL": {}, "SENTRY_DSN": {"required": False}},
        "environments": {"production": {"value_store": "env", "required": ["SENTRY_DSN"]}, "staging": {}},
    }
    (folder / "credential.json").write_text(json.dumps(legacy))

    dry = await lift(dry_run=True, roots=[mount])
    assert dry.stripped and "value_store" in json.loads((folder / "credential.json").read_text())

    report = await lift(dry_run=False, roots=[mount])

    here = await Deployment.this_computer()
    assert {n: r.type for n, r in here.secrets.exceptions.items()} == {"DATABASE_URL": "vault", "SENTRY_DSN": "vault"}
    prod = await Deployment.get_by_id(production.id)
    assert prod.secrets.store_of("DATABASE_URL").type == "env_file", "production kept its env file"
    assert prod.secrets.require == ["SENTRY_DSN"]
    assert (await Deployment.get_by_id(local.id)).secrets is None, "inherits the lifted vault exception"
    assert report.orphans == ["staging (db)"]
    assert set(json.loads((folder / "credential.json").read_text())) == {"name", "schema", "setup", "vars"}

    again = await lift(dry_run=False, roots=[mount])
    assert again.stripped == [] and again.lifted == []
