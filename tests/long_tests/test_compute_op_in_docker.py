"""The ten compute ops, in a clean container, with a real model behind the agent rung.

A goal only means something on a machine that can actually fail: a package index
that really is empty, a PATH that really does not include ``~/.local/bin``, a
port that really is taken. So the block is proven here rather than against fakes
— the fast tier (``tests/unit/test_compute_op_runner.py``) already pins the state
machine in milliseconds, and this pins that the machine is right about reality.

The agent rung is **Claude Code + OpenRouter + GLM 5.3**: funded through the
product's own two routes (``lm_keys`` → ``llm-endpoint/select``) and pinned with
``Capability.model_map``, so a device-funded login cannot be mistaken for it.

Needs docker and ``OPENROUTER_API_KEY`` (env or ``.env.local``); skips otherwise.
Rebuild the image after changing SDK code: ``FLOWPAD_OP_REBUILD=1``.
"""
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest

REPO = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("FLOWPAD_DOCKER_IMAGE", "flowpad-backend:compute-op-test")
MODEL = os.environ.get("FLOWPAD_OP_MODEL", "z-ai/glm-5.3")

# A fresh container pays for an apt index, a redis install and three cold model
# turns. Do NOT raise this to make a slow case pass — a rung that needs longer
# than its own declared budget is the bug.
pytestmark = [pytest.mark.timeout(1800)]


def _openrouter_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key and (REPO / ".env.local").is_file():
        match = re.search(r"^\s*OPENROUTER_API_KEY\s*=(.+)$", (REPO / ".env.local").read_text(), re.M)
        key = match.group(1).strip().strip("'\"") if match else ""
    return key


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _sh(*args: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def _exec(name: str, script: str, *, check: bool = False) -> subprocess.CompletedProcess:
    return _sh("docker", "exec", "-i", name, "sh", "-c", script, check=check)


@pytest.fixture(scope="module")
def container():
    if shutil.which("docker") is None or _sh("docker", "info", check=False).returncode != 0:
        pytest.skip("docker is not available")
    key = _openrouter_key()
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set (env or .env.local)")

    missing = _sh("docker", "image", "inspect", IMAGE, check=False).returncode != 0
    if missing or os.environ.get("FLOWPAD_OP_REBUILD"):
        build = _sh("docker", "build", "-f", "docker/Dockerfile.flow-backend", "-t", IMAGE, ".",
                    cwd=REPO, check=False)
        if build.returncode != 0:
            # An environment problem, not a case failure: stop the session rather
            # than reporting ten broken goals.
            pytest.exit(f"docker build failed:\n{build.stdout[-2000:]}\n{build.stderr[-2000:]}", returncode=2)

    name, port = f"flowpad-op-{uuid.uuid4().hex[:6]}", _free_port()
    _sh("docker", "run", "-d", "--name", name, "-p", f"{port}:{port}",
        "-e", f"LOCAL_SERVER_PORT={port}", "-e", "IS_SANDBOX=1", "-e", "MINIHUB_RELOAD=False", IMAGE)
    try:
        base = f"http://localhost:{port}"
        deadline = time.monotonic() + 120
        while time.monotonic() < deadline:
            try:
                if httpx.get(f"{base}/api/v1/health/status", timeout=2).status_code == 200:
                    break
            except httpx.HTTPError:
                pass
            time.sleep(1)
        else:
            pytest.fail(f"backend in {name} did not come up:\n"
                        f"{_sh('docker', 'logs', name, check=False).stderr[-2000:]}")
        _sh("docker", "cp", str(REPO / "tests"), f"{name}:/app/tests")
        # No key in here: pytest prints a fixture's value on every failure in
        # the test that uses it, and a leaked credential in a log is forever.
        yield {"name": name, "base": base, "port": port}
    finally:
        _sh("docker", "rm", "-f", name, check=False)


@pytest.fixture(scope="module")
def funded(container):
    """Claude Code, funded by OpenRouter, pinned to GLM 5.3 — the product's own routes."""
    base, name = container["base"], container["name"]
    keyed = httpx.post(f"{base}/api/v1/graph/compute_node/@local/lm_keys",
                       json={"provider": "openrouter", "key": _openrouter_key()}, timeout=60)
    assert keyed.status_code == 200 and (keyed.json().get("data") or {}).get("valid") is True, keyed.text[:300]

    selected = httpx.post(f"{base}/api/v1/graph/compute_node/@local/llm-endpoint/select",
                          json={"harness": "claude", "kind": "api_key", "provider": "openrouter"}, timeout=60)
    assert selected.status_code == 200, selected.text[:300]

    pinned = _exec(name, "python3 - <<'PY'\n"
        "import asyncio\n"
        "from flow_sdk.builtin.capability import Capability\n"
        "from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind\n"
        "async def main():\n"
        "    cap = await Capability.get_by_kind(worker_capability_kind('claude'))\n"
        f"    cap.model_map = {{'openrouter': {{t: {MODEL!r} for t in ('sm', 'md', 'lg')}}}}\n"
        "    await cap.save()\n"
        "    print(cap.auth_mode, cap.api_provider)\n"
        "asyncio.run(main())\nPY")
    assert pinned.stdout.split() == ["api", "openrouter"], f"{pinned.stdout}\n{pinned.stderr[-800:]}"
    return container


def _cases(output: str) -> dict[str, dict]:
    return {row["case"]: row for row in
            (json.loads(line[5:]) for line in output.splitlines() if line.startswith("CASE "))}


def _drive(container, *names: str, timeout: int = 1500) -> dict[str, dict]:
    """Run the named ops in the container and return one row per case."""
    done = _sh("docker", "exec", "-i", container["name"], "sh", "-c",
               f"cd /app && python3 tests/long_tests/compute_op_driver.py {' '.join(names)}",
               check=False, timeout=timeout)
    rows = _cases(done.stdout)
    assert rows, f"the driver produced no cases:\n{done.stdout[-2000:]}\n{done.stderr[-2000:]}"
    return rows


# ── the model actually answers, before anything depends on it ────────────────

def test_glm_answers_through_claude_code(funded):
    """The riskiest assumption in the rig, asserted first and alone.

    OpenRouter is addressed on the Anthropic-shaped endpoint, so "can Claude Code
    drive a non-Anthropic model" is an empirical question. If this fails, nothing
    below it means anything — and the failure should say so rather than looking
    like ten broken goals.
    """
    _exec(funded["name"], "mkdir -p /work")
    answered = _exec(funded["name"], "python3 - <<'PY'\n"
        "import asyncio\n"
        "from flow_sdk.core.wizard.process_step import launch_step_process\n"
        "async def main():\n"
        "    out = await launch_step_process(agent='provisioner',\n"
        "        prompt='Reply with exactly: RIG-OK. Do not run any command.',\n"
        "        name='smoke', workdir=__import__('pathlib').Path('/work'), timeout_seconds=600)\n"
        "    print('SMOKE', out.ok, out.message[:400])\n"
        "asyncio.run(main())\nPY", check=False)
    assert "SMOKE True" in answered.stdout, (
        f"GLM 5.3 did not answer through Claude Code.\n{answered.stdout[-1500:]}\n{answered.stderr[-1500:]}"
    )


# ── the cheap, deterministic mechanisms ──────────────────────────────────────

def test_a_goal_already_true_on_arrival_runs_nothing(funded):
    # git ships in this image, so the check answers and no attempt runs.
    row = _drive(funded, "git-on-path")["git-on-path"]
    assert row["ready"] and "already satisfied" in row["detail"]


def test_not_applicable_is_a_pass_not_a_failure(funded):
    # Alpine-only, on a Debian image: the check says "not mine" with exit 3.
    row = _drive(funded, "apk-cache-warm")["apk-cache-warm"]
    assert row["ready"] and "not applicable here" in row["detail"]


def test_the_plain_case_installs_once_then_does_nothing(funded):
    first = _drive(funded, "jq-on-path")["jq-on-path"]
    assert first["ready"], first
    assert "the command attempt did it" in first["detail"]

    second = _drive(funded, "jq-on-path")["jq-on-path"]
    assert second["ready"] and "already satisfied" in second["detail"]
    # The whole idempotency claim: the second run is one check and nothing else.
    assert second["seconds"] < first["seconds"]


def test_an_unreachable_goal_reports_pending_and_does_not_raise(funded):
    row = _drive(funded, "unreachable")["unreachable"]
    assert row["ready"] is False
    assert row["pending"] == ["unreachable"]
    assert "error" not in row, "attempts exhausted is a verdict, not an exception"


# ── escalation: the cheap rung reports success, the goal is still not met ─────

def test_the_agent_rescues_an_install_the_cheap_rung_could_not_do(funded):
    """`apt-get install` against an empty package index fails.

    The command rung is written WITHOUT `apt-get update` on purpose — it is the
    most common real failure of a first install, and the whole point of having a
    rung that can read the error. The driver empties the index first, so this
    does not depend on which case ran before it.
    """
    row = _drive(funded, "ripgrep-on-path")["ripgrep-on-path"]
    assert row["ready"], row
    assert "the process attempt did it" in row["detail"]


def test_a_rung_that_exits_zero_without_reaching_the_goal_escalates(funded):
    """`pip install --user` exits 0 and lands the script in ~/.local/bin, which is
    not on a non-login shell's PATH. The rung succeeded; the goal is not reached."""
    row = _drive(funded, "cowsay-on-path")["cowsay-on-path"]
    assert row["ready"], row
    assert "the process attempt did it" in row["detail"]


def test_a_started_service_that_answers_the_wrong_thing_is_not_done(funded):
    """`python3 -m http.server` starts happily and 404s /health.

    Exit 0 from the rung, failure from the check — the case that breaks any
    design that trusts the attempt instead of the question.
    """
    row = _drive(funded, "app-answers")["app-answers"]
    assert row["ready"], row
    assert "the process attempt did it" in row["detail"]


def test_a_service_goal_is_reached_and_then_left_alone(funded):
    first = _drive(funded, "redis-running")["redis-running"]
    assert first["ready"], first
    second = _drive(funded, "redis-running")["redis-running"]
    assert second["ready"] and "already satisfied" in second["detail"]


# ── composition ──────────────────────────────────────────────────────────────

def test_a_chain_three_deep_proves_each_link_before_the_next(funded):
    rows = _drive(funded, "deps-installed")
    assert rows["deps-installed"]["ready"], rows
    # Only the goal reports; its dependencies ran inside it. That they ran is
    # visible in the machine: git exists, the clone is there, the import works.
    checks = _exec(funded["name"],
                   "command -v git >/dev/null && test -d /work/demo-repo/.git && "
                   "python3 -c 'import tabulate' && echo CHAIN-OK")
    assert "CHAIN-OK" in checks.stdout, checks.stderr[-800:]


# ── the asset and CLI layer ──────────────────────────────────────────────────

def test_the_asset_layer_round_trips_and_answers_flow_op_check(funded):
    """Create through the entity API, and the CLI answers about the same op.

    This is the layer the pure runner deliberately knows nothing about: the row,
    the rendered document beside it, and the exit code that a wizard check reads.
    """
    created = httpx.post(f"{funded['base']}/api/v1/graph/compute_op", timeout=60, json={
        "name": "rig-workspace",
        "label": "the rig workspace",
        "description": "/work exists.",
        "check": {"commands": {"linux": "test -d /work"}},
        "attempts": [{"command": {"commands": {"linux": "mkdir -p /work"}}}],
        "setup": "The container already has /work.\n",
    })
    assert created.status_code == 200, created.text[:300]

    # The row rendered its own document, body file and all.
    written = _exec(funded["name"], "cat /root/agentic-assets/compute_op/rig-workspace/compute_op.json; "
                                   "ls /root/agentic-assets/compute_op/rig-workspace/")
    assert '"linux": "test -d /work"' in written.stdout, written.stdout
    assert "setup.md" in written.stdout, written.stdout

    checked = _exec(funded["name"], "cd /app && flow op check rig-workspace")
    assert checked.returncode == 0, f"{checked.stdout}\n{checked.stderr[-800:]}"
    assert '"outcome": "satisfied"' in checked.stdout, checked.stdout

    # Not shipped by this instance, so running it needs an explicit approval —
    # the gate refuses rather than parking a headless caller.
    refused = _exec(funded["name"], "cd /app && flow op run rig-workspace")
    assert refused.returncode != 0 and "Approve it" in refused.stdout + refused.stderr
    approved = _exec(funded["name"], "cd /app && flow op run rig-workspace --approved")
    assert approved.returncode == 0, f"{approved.stdout}\n{approved.stderr[-800:]}"
