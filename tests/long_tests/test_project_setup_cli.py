"""``flow project setup`` — the literal command, a real backend, a person at the terminal.

A project holds a Telegram source, whose driver names the ``telegram`` credential; nothing declares
it yet. The command is run the way a person runs it — a subprocess in the project folder, the token
typed on stdin — and every step it shells out to (``flow credentials set/check``) reaches the
running backend over HTTP. Then:

* ``--dry-run`` lists the credential as missing, and changes nothing;
* the typed token lands in the project's ``.env.local`` (declared from the shipped template), and
  appears nowhere in what the command printed;
* a second run asks nothing and skips every step.
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
from pathlib import Path

import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.project import Project
from flow_sdk.ingest.testing import make_data_source
from tests.long_tests._deployments import run

pytestmark = [pytest.mark.timeout(90)]  # do not increase timeout without approval

TOKEN = "987654:typed-at-the-terminal"


def _flow(project_dir: Path, *argv: str, stdin: str = "") -> subprocess.CompletedProcess:
    from flow_sdk.db.drivers.db_driver import _driver_instances

    env = {**os.environ, "SQLITE_DATABASE_PATH": str(_driver_instances["sqlite"].config.database),
           "FLOWPAD_SKIP_DOTENV": "true"}
    return subprocess.run([sys.executable, "-m", "flow_sdk.cli.flow_cli", *argv], cwd=project_dir, env=env,
                          input=stdin, capture_output=True, text=True, timeout=60)


@pytest.mark.long  # ~12s: a real backend boot, and three CLI runs that each shell out to the CLI
def test_flow_project_setup_asks_stores_and_resumes(live_backend, tmp_path):
    project_dir = tmp_path / "shop"
    project_dir.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=project_dir, check=True)
    project = run(Project(name="shop", fs_storage_mount_path=str(project_dir)).save())
    run(make_data_source("telegram", name="shop bot", project_id=project.id).save())

    listed = _flow(project_dir, "project", "setup", "--dry-run", "--json")
    assert listed.returncode == 0, listed.stderr[-2000:]
    (telegram,) = [r for r in json.loads(listed.stdout.splitlines()[-1])["requirements"] if r["name"] == "telegram"]
    assert telegram["state"] == "missing TELEGRAM_BOT_TOKEN" and telegram["ai_setup"]
    assert not (project_dir / ".env.local").exists(), "a dry run changes nothing"

    done = _flow(project_dir, "project", "setup", "--no-ai", stdin=TOKEN + "\n")
    said = done.stdout + done.stderr
    assert done.returncode == 0, said[-3000:]
    assert dotenv_values(project_dir / ".env.local")["TELEGRAM_BOT_TOKEN"] == TOKEN
    assert TOKEN not in said, "the typed token is never printed"
    assert "Telegram bot: Bot token" in done.stderr, "the question is asked on the terminal"
    assert "Everything is set up." in done.stdout

    again = _flow(project_dir, "project", "setup")
    assert again.returncode == 0, (again.stdout + again.stderr)[-3000:]
    assert "Bot token" not in again.stderr, "nothing is asked twice"
    assert "✓  Store Telegram bot: already done" in again.stdout
