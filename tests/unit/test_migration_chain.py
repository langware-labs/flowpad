"""An upgrade across releases runs the recipes it skipped, once each, and never the stranded ones.

``run_if_needed`` ran only the running version's own recipe, so 0.2.25 -> 0.2.261 never ran
0.2.26's (the per-instance copy p13's docker upgrade checks). Chaining everything was rejected:
it re-drives the six recipes 0.2.153 declares ``STRANDED``, the 249 s launch hang 69e5cc510
removed. The chain is narrow: above the installed version, below the new one (whose own recipe
runs as before), never a declared-stranded recipe, never one already recorded (done, failed or
orphaned), each run once and recorded.
"""

from __future__ import annotations

import json
import time
from pathlib import Path

import pytest

from flow_sdk.migrations import runner
from flow_sdk.migrations import status as migration_status
from flow_sdk.migrations.status import MigrationRecord, MigrationStatus

REAL_RECIPES = Path(runner.__file__).resolve().parents[1] / "system_projects" / "flowpad_assistant" / "migrations"


def _recipe(root: Path, version: str, body: str = "") -> None:
    script = root / version / "scripts" / "migrate.py"
    script.parent.mkdir(parents=True)
    log = root / "ran.log"
    script.write_text(f"{body}\ndef run():\n    open({str(log)!r}, 'a').write({version!r} + '\\n')\n")


def _ran(root: Path) -> list[str]:
    log = root / "ran.log"
    return log.read_text().split() if log.exists() else []


@pytest.fixture()
def dirs(tmp_path, monkeypatch):
    root, status_dir = tmp_path / "recipes", tmp_path / "status"
    root.mkdir()
    monkeypatch.setenv("FLOWPAD_MIGRATIONS_ROOT", str(root))
    monkeypatch.setattr(runner, "_resolve_status_dir", lambda: status_dir)
    return root, status_dir


@pytest.mark.asyncio
async def test_an_upgrade_runs_the_skipped_recipes_once_and_never_the_stranded_ones(dirs):
    root, status_dir = dirs
    _recipe(root, "0.2.26")
    _recipe(root, "0.2.95")  # declared stranded below
    _recipe(root, "0.2.153", 'STRANDED = ("0.2.95",)')
    _recipe(root, "0.2.200")
    _recipe(root, "0.2.262")  # newer than the running version

    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    assert _ran(root) == ["0.2.26", "0.2.153", "0.2.200"]
    for version in ("0.2.26", "0.2.153", "0.2.200"):
        assert migration_status.read(status_dir, version).status == "completed"
    assert migration_status.read(status_dir, "0.2.95") is None
    assert migration_status.read(status_dir, "0.2.262") is None

    # A second start owes nothing: each ran once.
    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    assert _ran(root) == ["0.2.26", "0.2.153", "0.2.200"]


@pytest.mark.asyncio
async def test_only_recipes_above_the_installed_version_run(dirs):
    root, status_dir = dirs
    for version in ("0.2.26", "0.2.150", "0.2.200", "0.2.246"):
        _recipe(root, version)
    migration_status.write(status_dir, MigrationRecord.fresh("0.2.150", pid=1).transition(MigrationStatus.COMPLETED))
    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    assert _ran(root) == ["0.2.200", "0.2.246"]


@pytest.mark.asyncio
async def test_an_interrupted_chain_resumes_after_its_last_record_and_never_retries_it(dirs):
    root, status_dir = dirs
    for version in ("0.2.26", "0.2.153", "0.2.200"):
        _recipe(root, version)
    migration_status.write(status_dir, MigrationRecord.fresh("0.2.26", pid=1).transition(MigrationStatus.COMPLETED))
    migration_status.write(status_dir, MigrationRecord.fresh("0.2.153", pid=1).transition(MigrationStatus.ERROR, error_msg="interrupted"))
    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    assert _ran(root) == ["0.2.200"]
    assert migration_status.read(status_dir, "0.2.153").status == "error"


@pytest.mark.asyncio
async def test_a_failing_older_recipe_is_recorded_and_does_not_block_the_start(dirs):
    root, status_dir = dirs
    (root / "0.2.30" / "scripts").mkdir(parents=True)
    (root / "0.2.30" / "scripts" / "migrate.py").write_text("def run():\n    raise RuntimeError('boom')\n")
    _recipe(root, "0.2.40")
    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    assert migration_status.read(status_dir, "0.2.30").status == "error"
    assert _ran(root) == ["0.2.40"]


def test_the_shipped_chain_from_0_2_25_skips_every_stranded_recipe(tmp_path, monkeypatch):
    monkeypatch.delenv("FLOWPAD_MIGRATIONS_ROOT", raising=False)
    pending = runner._chain_pending("0.2.261", tmp_path / "status")
    stranded = set(runner._declared_stranded(REAL_RECIPES))
    assert stranded == {"0.2.95", "0.2.103", "0.2.112", "0.2.121", "0.2.137", "0.2.150"}
    assert "0.2.26" in pending and not stranded & set(pending)
    assert all(runner._version_key(v) < (0, 2, 261) for v in pending)


@pytest.mark.asyncio
async def test_the_shipped_chain_from_0_2_25_stays_within_the_launch_budget(tmp_path, monkeypatch):
    """69e5cc510 made the launch path instant (0.2.153's recipe: 0.0 ms) after 249 s. The whole
    chain a 0.2.25 install owes, on an empty home, must stay a few seconds: budget 10 s."""
    monkeypatch.delenv("FLOWPAD_MIGRATIONS_ROOT", raising=False)
    home = tmp_path / "flow_home"
    monkeypatch.setenv("FLOW_HOME", str(home))
    monkeypatch.setattr(runner, "_resolve_status_dir", lambda: home / "global" / "migrations")
    started = time.monotonic()
    assert await runner._run_if_needed_async("0.2.261", 5) == 0
    elapsed = time.monotonic() - started
    records = migration_status.list_all(home / "global" / "migrations")
    print(json.dumps({"chain_s": round(elapsed, 2), "ran": {r.version: r.status for r in records}}))
    assert elapsed < 10, f"chain took {elapsed:.1f}s"
    assert not {r.version for r in records} & runner._declared_stranded(REAL_RECIPES)
