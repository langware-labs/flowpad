"""A credential, end to end: declared → filled by the AI rung of ``flow project setup`` → stored → status.

The literal commands, a real backend, the mock worker as the agent — ``tests.utils.demo_credential``,
a few lines of Python that do what a model following the credential's ``setup`` does, so this pins
the I/O between the pieces, not how well a model reads instructions:

1. ``flow credentials declare secret_pack.json`` in a bare folder — the folder becomes a project, the
   credential its own;
2. ``flow project setup`` with nobody at the terminal — every question left empty, so the AI rung runs;
3. the values are in the project's ``.env.local``, on their patterns, and ``flow credentials check``
   passes; the generated key is in nothing the CLI printed and nowhere in the agent's transcript;
4. the status, read through the Python SDK and over REST, says the same;
5. a second ``flow project setup`` launches no agent and asks nothing.
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from pathlib import Path

import httpx
import pytest
from dotenv import dotenv_values

from flow_sdk.builtin.credential_status import credentials_status
from flow_sdk.builtin.project import Project
from tests.long_tests._deployments import run
from tests.utils.demo_credential import ENDPOINT, KEY_PATTERN, MANIFEST_PATH

pytestmark = [pytest.mark.timeout(60)]  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]


def _flow(project_dir: Path, transcripts: Path, *argv: str) -> subprocess.CompletedProcess:
    """``flow <argv>`` in ``project_dir``, the agent it launches on the mock worker. Nobody at the terminal."""
    from flow_sdk.db.drivers.db_driver import _driver_instances

    env = {**os.environ, "SQLITE_DATABASE_PATH": str(_driver_instances["sqlite"].config.database),
           "FLOWPAD_SKIP_DOTENV": "true", "MOCK_TRANSCRIPTS": str(transcripts),
           "MOCK_BEHAVIOR": "tests.utils.demo_credential:follow_setup", "PYTHONPATH": str(REPO)}
    return subprocess.run([sys.executable, str(REPO / "tests/utils/mock_flow_cli.py"), *argv], cwd=project_dir, env=env,
                          stdin=subprocess.DEVNULL, capture_output=True, text=True, timeout=30)


def _assert_filled(row: dict, key: str) -> None:
    """One credential row of the status, as the Python SDK and REST both give it."""
    assert (row["scope"], row["state"], row["environment"]) == ("project", "connected", "development"), row
    for var in row["vars"]:
        assert (var["present"], var["found_in"], var["warning"]) == (True, "env", None), var
    assert key not in json.dumps(row), "the status names what is present, never a value"


@pytest.mark.long  # 11.2s: a real backend boot and five CLI runs, one of them launching the mock agent
def test_declared_credential_is_filled_by_the_ai_rung_and_reported(live_backend, tmp_path):
    project_dir, transcripts = tmp_path / "demo", tmp_path / "transcripts"
    project_dir.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=project_dir, check=True)
    (project_dir / "service.url").write_text(ENDPOINT + "\n")

    # 1. declare — the folder becomes a project, the credential its own.
    declared = _flow(project_dir, transcripts, "credentials", "declare", str(MANIFEST_PATH))
    assert declared.returncode == 0, declared.stderr[-2000:]
    project_id = json.loads(declared.stdout.splitlines()[-1])["project_id"]
    assert (project_dir / "agentic-assets/secret_pack/demo-service/secret_pack.json").is_file()

    # 2. setup, nobody at the terminal: every question left empty → the AI rung.
    done = _flow(project_dir, transcripts, "project", "setup", "--json")
    said = done.stdout + done.stderr
    assert done.returncode == 0, said[-3000:]
    (outcome,) = json.loads(done.stdout.splitlines()[-1])["requirements"]
    assert (outcome["name"], outcome["done"], outcome["ai_setup"]) == ("demo-service", True, True), outcome

    # 3. the values are stored, on their patterns, and the key went nowhere else.
    stored = dotenv_values(project_dir / ".env.local")
    key = stored["DEMO_API_KEY"]
    assert re.match(KEY_PATTERN, key) and stored["DEMO_ENDPOINT"] == ENDPOINT, sorted(stored)
    check = _flow(project_dir, transcripts, "credentials", "check", "demo-service")
    assert check.returncode == 0 and json.loads(check.stdout.splitlines()[-1])["ready"], check.stdout + check.stderr
    (transcript,) = transcripts.glob("*.jsonl")
    lines = transcript.read_text()
    assert "--stdin" in lines and "openssl rand" in lines, "the agent ran the setup's pipe"
    assert key not in lines, "the key never passed through the agent"
    assert key not in said + declared.stdout + declared.stderr + check.stdout + check.stderr

    # 4. the status — Python SDK in this process, REST from the backend.
    project = run(Project.get_by_id(project_id))
    status = run(credentials_status(project)).model_dump(mode="json")
    (row,) = [r for r in status["credentials"] if r["name"] == "demo-service"]
    _assert_filled(row, key)
    env_file = next(f for f in status["files"] if f["path"].endswith(".env.local") and "demo" in f["path"])
    assert env_file["exists"] and not env_file["blocked"], env_file
    rest = httpx.get(f"http://127.0.0.1:{live_backend}/api/v1/graph/compute_node/@local/credentials/status",
                     params={"project_id": project_id}, timeout=10).json()["data"]
    (rest_row,) = [r for r in rest["credentials"] if r["name"] == "demo-service"]
    _assert_filled(rest_row, key)

    # 5. again: already done — no question, no agent.
    again = _flow(project_dir, transcripts, "project", "setup")
    assert again.returncode == 0, (again.stdout + again.stderr)[-3000:]
    assert "Leave it empty" not in again.stderr and "already done" in again.stdout
    assert len(list(transcripts.glob("*.jsonl"))) == 1, "a credential that holds launches no agent"
