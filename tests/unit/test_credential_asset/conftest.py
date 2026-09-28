"""Isolated DB for credential-asset tests.

The same driver swap `test_data_source_asset` and `test_folder_source` use: a
test that mints entities through the real walker must not leak rows into its
neighbours.
"""
import subprocess

import pytest
import pytest_asyncio

import flow_sdk.db.drivers.db_driver as db_driver_mod
import flow_sdk.fs_store.indexer.registrations  # noqa: F401 — registers every TypeInfo
import flow_sdk.models.entities  # noqa: F401 — registers every Entity CLASS (asset_owner_classes)
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_driver import DBConfig
from flow_sdk.db.drivers.sqlite.sqlite_driver import SQLiteDBDriver


@pytest_asyncio.fixture
async def folder_db(tmp_path):
    """Isolated driver bound to ``Entity`` — same swap/restore as fs_store."""
    cfg = DBConfig()
    cfg.database = str(tmp_path / "credential_asset.db")
    driver = SQLiteDBDriver(cfg)
    await driver.open()

    old_instances = db_driver_mod._driver_instances.copy()
    db_driver_mod._driver_instances["sqlite"] = driver
    old_db = Entity.__dict__.get("_db")
    Entity._db = driver

    yield driver

    db_driver_mod._driver_instances.clear()
    db_driver_mod._driver_instances.update(old_instances)
    if old_db is None:
        if "_db" in Entity.__dict__:
            delattr(Entity, "_db")
    else:
        Entity._db = old_db
    await driver.close()


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
    from flow_sdk.builtin.project import Project

    mount = tmp_path / "proj"
    mount.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=mount, check=True)
    p = Project(name=str(mount))
    p.fs_storage_mount_path = str(mount)
    await p.save()
    return p


@pytest.fixture
def run_flow(monkeypatch):
    """``await run_flow("credentials", ...)``: the real ``flow`` CLI, in-process against this test's DB.

    The command's service coroutines run on the test's own loop (``_here``) while Typer runs in a
    thread; no backend is discovered.
    """
    import asyncio

    from typer.testing import CliRunner

    from flow_sdk.cli import flow_cli
    from flow_sdk.cli.commands import credentials_cmd

    async def run(*argv: str, input: str | None = None):
        running = asyncio.get_running_loop()
        monkeypatch.setattr(credentials_cmd, "discover_port", lambda required=True: None)
        monkeypatch.setattr(credentials_cmd, "_here", lambda coro: asyncio.run_coroutine_threadsafe(coro, running).result())
        return await asyncio.to_thread(CliRunner().invoke, flow_cli.app, list(argv), input=input)

    return run


@pytest.fixture
def instance_config(monkeypatch):
    """This instance's config.json in memory: a default environment or a migration stamp set here must not
    outlive the test."""
    from flow_sdk.cli import app_config

    held: dict = {}
    monkeypatch.setattr(app_config, "get_config", lambda key, default=None: held.get(key, default))
    monkeypatch.setattr(app_config, "set_config", lambda key, value: held.__setitem__(key, value))
    return held


@pytest.fixture
def catalogue(monkeypatch):
    """``catalogue("whatsapp", ...)``: the shipped credential templates this test's catalogue holds, as the index
    holds them (``system``-scope rows read from the shipped folders)."""
    import json
    from pathlib import Path

    from flow_sdk.builtin import credential_service
    from flow_sdk.builtin.credential import Credential
    from flow_sdk.schema.data_spec.credential_spec import CredentialSpec

    shipped_root = Path(credential_service.__file__).parents[1] / "system_projects/flowpad_assistant/agentic-assets/credential"

    def template(name: str) -> Credential:
        spec = CredentialSpec.model_validate(json.loads((shipped_root / name / "credential.json").read_text()))
        fields = {f: getattr(spec, f) for f in credential_service._MANIFEST_FIELDS}
        return Credential(name=spec.name, scope="system", manifest_schema=spec.manifest_schema, **fields)

    def holding(*names: str) -> list:
        shipped = [template(n) for n in names]

        async def listed():
            return shipped

        monkeypatch.setattr(credential_service, "shipped_templates", listed)
        return shipped

    return holding


@pytest.fixture
def templates(catalogue):
    return catalogue("gmail", "openai", "telegram", "twilio")
