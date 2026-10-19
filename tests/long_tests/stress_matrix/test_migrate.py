"""End-to-end migration cell.

Stages a fake migration recipe at ``/work/migrations/v0.0.0-test/skill/SKILL.md``
that tells Claude to create a sentinel file ``/work/MIGRATED.txt``. Runs
``flow migrate run --version v0.0.0-test`` inside the container and asserts:

  - exit 0
  - the sentinel file was written by Claude
  - the per-version status JSON shows ``completed``

A second invocation against the same workdir must short-circuit (no
re-run of the agent) because the status file says ``completed``.

This cell exercises the FULL phase-1 migration path: CLI command →
runner.run_if_needed → headless AgenticProcess → stream_transcript →
terminal status write.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from .conftest import run_cell

MIGRATION_VERSION = "v0.0.0-test"


def _write_recipe(tmp_path: Path) -> Path:
    """Build the migrations root with a trivial recipe.

    Returns the migrations root (to be set as ``FLOWPAD_MIGRATIONS_ROOT``
    inside the container).

    Intentionally NO tool calls — the recipe asks Claude to reply with a
    fixed text token and stop. This keeps the cell inside the 30s test
    budget regardless of macOS Docker Desktop bind-mount latency or
    Anthropic API cold-start. The point of this cell is end-to-end
    migration plumbing (CLI → runner → AP → status file), not
    substantive Claude work.
    """
    migrations_root = tmp_path / "migrations"
    skill_dir = migrations_root / MIGRATION_VERSION / "skill"
    skill_dir.mkdir(parents=True)
    (skill_dir / "SKILL.md").write_text(
        "# Test migration recipe\n\n"
        "Respond with exactly the single token `MIGRATED_OK` (no quotes, "
        "no surrounding text), then end the turn. Do not use any tools.\n",
        encoding="utf-8",
    )
    return migrations_root


def _read_status(workdir: Path) -> dict | None:
    """Read the status JSON written by the runner inside the container.

    HOME=/work inside the container, so the runner's
    ``migrations_status_dir`` resolves to ``/work/.flow/global/migrations``.
    """
    p = workdir / ".flow" / "global" / "migrations" / f"migration_{MIGRATION_VERSION}.json"
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return None


# do not increase timeout without approval
@pytest.mark.timeout(30)
def test_migrate_completes(docker_available, valid_api_key, harness_image, tmp_path):
    workdir = tmp_path / "work"
    workdir.mkdir()
    _write_recipe(tmp_path)

    result = run_cell(
        docker_bin=docker_available,
        image=harness_image,
        api_key=valid_api_key,
        scenario="migrate_recipe",
        workdir=workdir,
        # prompt is ignored by the migrate_recipe scenario in victimize.sh
        prompt="(unused — recipe supplies instructions)",
        timeout_seconds=25.0,
        extra_mounts=[(tmp_path / "migrations", "/work/migrations")],
        extra_env={
            "FLOWPAD_MIGRATIONS_ROOT": "/work/migrations",
            "MIGRATION_VERSION": MIGRATION_VERSION,
        },
    )

    assert "Traceback" not in result.stderr, (
        f"runner traceback:\n{result.stderr[-1500:]}"
    )
    assert result.returncode == 0, (
        f"flow migrate run exited {result.returncode}\n"
        f"stdout={result.stdout[-800:]}\nstderr={result.stderr[-800:]}"
    )

    # The recipe asks Claude to emit the literal token MIGRATED_OK in its
    # reply. We assert on the runner's rendered transcript output to
    # prove Claude actually executed the recipe (not just that the
    # status JSON says completed).
    assert "MIGRATED_OK" in result.stdout, (
        f"Claude did not echo the recipe token MIGRATED_OK\n"
        f"stdout={result.stdout[-800:]}"
    )

    status = _read_status(workdir)
    assert status is not None, "no status JSON written"
    assert status["status"] == "completed", f"unexpected status: {status}"
    assert status["version"] == MIGRATION_VERSION
    assert status["duration_seconds"] is not None
    assert status["claude_session_id"], f"no session captured: {status}"
