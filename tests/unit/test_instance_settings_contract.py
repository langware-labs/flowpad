"""Regression tests for the instance-settings SoT contract (Commit 1).

The contract: env is an input, never a channel. ``InstanceSettings.from_env``
reads env exactly once; nothing in ``flow_sdk/`` writes instance-scoped env
vars back after that. The previous bug class:

- ``flow_sdk/config.py`` validator wrote ``SQLITE_DATABASE_PATH`` and
  ``FS_RECORD_PATH`` into ``os.environ`` at module-import time (before
  ``.env.local`` loaded). Settings resolved as "prod"; env got pinned to
  "prod" paths. Even after ``FLOW_INSTANCE=app`` was loaded and the
  singleton was reset, the path resolvers re-read the poisoned env and
  silently returned the prod DB path. The "app" instance ran with its
  server.json under ``instances/app/`` but its DB under ``instances/prod/``;
  two processes sharing one SQLite file → "database disk image is malformed".
- ``flow_sdk/db/database.py:reinit_db`` (the UI "Switch DB" path) did the
  same thing on demand and never cleared the env after.

These tests pin the contract so the bugs cannot reappear silently.
"""

from __future__ import annotations

import os
from pathlib import Path

import pytest


# Instance-scoped env vars the validator and reinit_db used to write.
_FORBIDDEN_WRITE_KEYS = {
    "SQLITE_DATABASE_PATH",
    "FS_RECORD_PATH",
}


def _clean_instance_env(monkeypatch: pytest.MonkeyPatch) -> None:
    """Strip every env var that influences instance resolution.

    Keeps the test deterministic regardless of the developer's shell.
    """
    for name in (
        "SQLITE_DATABASE_PATH",
        "FS_RECORD_PATH",
        "FLOW_HOME",
        "FLOW_INSTANCE",
        "FLOWPAD_DEV",
        "FLOWPAD_TEST",
        "PYTEST_CURRENT_TEST",
    ):
        monkeypatch.delenv(name, raising=False)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.parametrize("instance", ["prod", "dev", "app", "oss"])
def test_db_and_server_json_share_instance_dir(
    instance: str, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """db_path and server_json_path must live under the same instance dir.

    Repro for the live incident: pre-fix, after the validator poisoned
    ``SQLITE_DATABASE_PATH`` to ``instances/prod/flowpad.db``, a later
    ``FLOW_INSTANCE=app`` boot resolved server.json to ``instances/app/``
    but db_path stayed at ``instances/prod/``. This test catches the split.
    """
    _clean_instance_env(monkeypatch)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", instance)

    from flow_sdk.instance_settings import (
        get_instance_settings,
        reset_instance_settings,
    )

    reset_instance_settings()
    settings = get_instance_settings()

    assert settings.instance_name == instance
    assert settings.db_path.parent == settings.server_json_path.parent, (
        f"split instance: db_path={settings.db_path} "
        f"server_json_path={settings.server_json_path}"
    )
    assert settings.db_path.parent == settings.instance_dir
    assert settings.records_root.parent == settings.instance_dir


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_validator_does_not_write_env(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``ServiceConfig.apply_desktop_config`` MUST NOT write instance-scoped
    env vars. Pre-fix, it mirrored the resolved DB / records paths back into
    ``os.environ``, pinning the wrong-instance values at import time.

    This test resets the cached singleton, instantiates a fresh
    ``ServiceConfig`` (which fires the validator), and asserts that the two
    forbidden keys are never touched.
    """
    _clean_instance_env(monkeypatch)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    writes: list[tuple[str, str]] = []
    original_setitem = os.environ.__class__.__setitem__

    def _recording_setitem(env, key, value):  # type: ignore[no-untyped-def]
        writes.append((str(key), str(value)))
        return original_setitem(env, key, value)

    monkeypatch.setattr(os.environ.__class__, "__setitem__", _recording_setitem)

    from flow_sdk.config import ServiceConfig
    from flow_sdk.instance_settings import reset_instance_settings

    reset_instance_settings()
    # Constructing ServiceConfig fires the apply_desktop_config validator
    # which historically wrote SQLITE_DATABASE_PATH / FS_RECORD_PATH.
    _ = ServiceConfig()

    offending = [(k, v) for k, v in writes if k in _FORBIDDEN_WRITE_KEYS]
    assert not offending, (
        f"ServiceConfig validator wrote to instance-scoped env vars: {offending}"
    )


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_override_db_path_updates_settings_without_env_writes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``override_db_path`` must mutate the cached singleton's db_path AND
    not write any instance-scoped env var.

    Pre-fix the only way to swap the DB was ``reinit_db`` writing
    ``SQLITE_DATABASE_PATH`` to ``os.environ`` and resetting the singleton.
    The override helper replaces that with a direct dataclass replace.
    """
    _clean_instance_env(monkeypatch)
    monkeypatch.setenv("FLOW_HOME", str(tmp_path))
    monkeypatch.setenv("FLOW_INSTANCE", "prod")

    from flow_sdk.instance_settings import (
        get_instance_settings,
        override_db_path,
        reset_instance_settings,
    )

    reset_instance_settings()
    settings_before = get_instance_settings()
    assert settings_before.db_path == settings_before.instance_dir / "flowpad.db"

    writes: list[tuple[str, str]] = []
    original_setitem = os.environ.__class__.__setitem__

    def _recording_setitem(env, key, value):  # type: ignore[no-untyped-def]
        writes.append((str(key), str(value)))
        return original_setitem(env, key, value)

    monkeypatch.setattr(os.environ.__class__, "__setitem__", _recording_setitem)

    new_path = tmp_path / "scratch.db"
    override_db_path(new_path)

    settings_after = get_instance_settings()
    assert settings_after.db_path == new_path
    # Same singleton key — only db_path changed.
    assert settings_after.instance_name == settings_before.instance_name
    assert settings_after.server_json_path == settings_before.server_json_path

    offending = [(k, v) for k, v in writes if k in _FORBIDDEN_WRITE_KEYS]
    assert not offending, (
        f"override_db_path wrote to instance-scoped env vars: {offending}"
    )


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_reinit_db_no_env_writes(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """``reinit_db`` is the UI "Switch DB" path. Pre-fix it wrote
    ``SQLITE_DATABASE_PATH`` to ``os.environ`` and never cleared it,
    permanently poisoning the process env. Post-fix it goes through
    ``override_db_path`` and writes nothing to env.

    Also verifies the driver cache is dropped (so the next ``get_db_driver``
    builds a fresh driver against the new path) and that
    ``get_instance_settings().db_path`` now reflects the new path.
    """
    from flow_sdk.db.database import reinit_db
    from flow_sdk.db.drivers.db_driver import _driver_instances
    from flow_sdk.instance_settings import get_instance_settings

    writes: list[tuple[str, str]] = []
    original_setitem = os.environ.__class__.__setitem__

    def _recording_setitem(env, key, value):  # type: ignore[no-untyped-def]
        writes.append((str(key), str(value)))
        return original_setitem(env, key, value)

    monkeypatch.setattr(os.environ.__class__, "__setitem__", _recording_setitem)

    new_db = tmp_path / "reinit.db"
    await reinit_db(str(new_db))

    offending = [(k, v) for k, v in writes if k in _FORBIDDEN_WRITE_KEYS]
    assert not offending, (
        f"reinit_db wrote to instance-scoped env vars: {offending}"
    )
    # The settings singleton is the source of truth — both ``db_path``
    # (which the next driver open resolves via ``get_database_path()``)
    # and ``get_database_path()`` itself must point at the new file.
    assert get_instance_settings().db_path == new_db
    from flow_sdk.db.drivers.sqlite.connection import get_database_path
    assert get_database_path() == str(new_db)


@pytest.mark.timeout(30)  # do not increase timeout without approval
@pytest.mark.asyncio
async def test_reinit_db_rebinds_lazy_db_driver(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """reinit_db must rebind DBEntity._db / DBRelationship._db.

    Pre-fix, reinit_db popped the old driver from ``_driver_instances`` and
    opened a fresh one, but ``DBEntity._db`` (set by ``LazyDBDriver.__get__``
    on first access) still pointed at the OLD closed driver. Any subsequent
    ``DBEntity._db.<method>`` call hit the closed instance.
    """
    from flow_sdk.db.database import reinit_db
    from flow_sdk.db.db_entity import DBEntity
    from flow_sdk.db.db_relationship import DBRelationship
    from flow_sdk.db.drivers.db_driver import _driver_instances, get_db_driver

    # Warm the LazyDBDriver descriptor so DBEntity._db is the current driver.
    starting_driver = get_db_driver()
    DBEntity._db = starting_driver  # mirror what initialize_test_db does
    DBRelationship._db = starting_driver

    new_db = tmp_path / "rebind.db"
    await reinit_db(str(new_db))

    rebound_driver = _driver_instances.get("sqlite")
    assert rebound_driver is not None, "reinit_db left _driver_instances empty"
    assert DBEntity._db is rebound_driver, (
        "DBEntity._db still points at the pre-reinit driver — split-brain"
    )
    assert DBRelationship._db is rebound_driver, (
        "DBRelationship._db still points at the pre-reinit driver — split-brain"
    )
