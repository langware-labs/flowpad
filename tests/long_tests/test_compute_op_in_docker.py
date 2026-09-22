"""The compute ops, in a clean container, with a real model behind the agent ops.

A goal only means something on a machine that can actually fail: a package index
that really is empty, a PATH that really does not include ``~/.local/bin``, a
port that really is taken. So the block is proven here rather than against fakes
— the fast tier (``tests/unit/test_compute_op_runner.py``) already pins the state
machine in milliseconds, and this pins that the machine is right about reality.

The agent op is **Claude Code + OpenRouter + GLM 5.3**: funded through the
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
# turns. Do NOT raise this to make a slow case pass — an op that needs longer
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
        if os.environ.get("FLOWPAD_OP_KEEP"):
            # A failed agent run is evidence: its transcript and the machine it
            # left behind are what the diagnosis reads. Remove it by hand.
            print(f"\nFLOWPAD_OP_KEEP: container {name} kept (docker rm -f {name})")
        else:
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


def _drive(container, *cases: str, flags: str = "", timeout: int = 1500) -> dict[str, dict]:
    """Run the named cases in the container and return one row per case.

    A case ``a+b`` is the caller's fallback: ``b`` runs only if ``a`` did not
    reach the goal. The ops themselves never sequence anything.
    """
    done = _sh("docker", "exec", "-i", container["name"], "sh", "-c",
               f"cd /app && python3 tests/long_tests/compute_op_driver.py {flags} {' '.join(cases)}",
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
        "from flow_sdk.core.compute.process_step import launch_step_process\n"
        "async def main():\n"
        "    out = await launch_step_process(agent='provisioner',\n"
        "        prompt='Reply with exactly: RIG-OK. Do not run any command.',\n"
        "        name='smoke', workdir=__import__('pathlib').Path('/work'), timeout_seconds=600)\n"
        "    print('SMOKE', out.ok, out.detail[:400], out.executor)\n"
        "asyncio.run(main())\nPY", check=False)
    assert "SMOKE True" in answered.stdout, (
        f"GLM 5.3 did not answer through Claude Code.\n{answered.stdout[-1500:]}\n{answered.stderr[-1500:]}"
    )


# ── the cheap, deterministic mechanisms ──────────────────────────────────────

def _escalated(row: dict) -> None:
    """The cli op ran and did NOT reach the goal; the agent op after it did."""
    assert row["ok"], row
    subkinds = [(c["subkind"], c["ok"]) for c in row["calls"]]
    assert subkinds == [("cli", False), ("agent", True)], row["calls"]
    assert row["calls"][1]["executor"], "an agent op names the process that ran it"


def test_a_goal_already_true_on_arrival_runs_nothing(funded):
    # git ships in this image, so the check answers and no call is made.
    row = _drive(funded, "git-on-path")["git-on-path"]
    assert row["ok"] and row["ran"] is False and "already satisfied" in row["detail"]


def test_not_applicable_is_a_pass_not_a_failure(funded):
    # Alpine-only, on a Debian image: the check says "not mine" with exit 3.
    row = _drive(funded, "apk-cache-warm")["apk-cache-warm"]
    assert row["ok"] and row["exit_code"] == 3 and "not applicable here" in row["detail"]


def test_the_plain_case_installs_once_then_does_nothing(funded):
    first = _drive(funded, "jq-on-path")["jq-on-path"]
    assert first["ok"] and first["ran"], first

    second = _drive(funded, "jq-on-path")["jq-on-path"]
    assert second["ok"] and second["ran"] is False and "already satisfied" in second["detail"]
    # The whole idempotency claim: the second run is one check and nothing else.
    assert second["seconds"] < first["seconds"]


def test_an_unreachable_goal_reports_not_yet_and_does_not_raise(funded):
    row = _drive(funded, "unreachable")["unreachable"]
    assert row["ok"] is False
    assert row["exit_code"] == 1, row  # NOT_YET: the goal does not hold, and may be tried again
    assert "error" not in row, "a call that did not reach the goal is an answer, not an exception"


# ── the caller's fallback: the cli op says done, the goal is still not met ────

def test_the_agent_rescues_an_install_the_cli_op_could_not_do(funded):
    """`apt-get install` against an empty package index fails.

    The cli op is written WITHOUT `apt-get update` on purpose — it is the most
    common real failure of a first install, and the whole point of an agent op
    that can read the error. The driver empties the index first, so this does
    not depend on which case ran before it.
    """
    case = "ripgrep-on-path+ripgrep-on-path-agent"
    _escalated(_drive(funded, case)[case])


def test_a_cli_op_that_exits_zero_without_reaching_the_goal_is_not_done(funded):
    """`pip install --user` exits 0 and lands the script in ~/.local/bin, which is
    not on a non-login shell's PATH. The call succeeded; the goal is not reached."""
    case = "cowsay-on-path+cowsay-on-path-agent"
    row = _drive(funded, case)[case]
    _escalated(row)


def test_a_started_service_that_answers_the_wrong_thing_is_not_done(funded):
    """`python3 -m http.server` starts happily and 404s /health.

    Exit 0 from the call, failure from the check — the case that breaks any
    design that trusts the call instead of the question.
    """
    case = "app-answers+app-answers-agent"
    _escalated(_drive(funded, case)[case])


def test_a_service_goal_is_reached_and_then_left_alone(funded):
    case = "redis-running+redis-running-agent"
    first = _drive(funded, case)[case]
    assert first["ok"], first
    second = _drive(funded, case)[case]
    assert second["ok"] and second["ran"] is False and "already satisfied" in second["detail"]
    assert len(second["calls"]) == 1, "a satisfied goal never reaches the fallback"


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
        "subkind": "cli",
        "exe_data": {"commands": {"linux": "mkdir -p /work"}},
        "completion_check": {"commands": {"linux": "test -d /work"}},
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
    assert '"exit_code": 0' in checked.stdout, checked.stdout

    # Not shipped by this instance, so running it needs an explicit approval —
    # the gate answers REFUSED (exit 7) rather than parking a headless caller.
    refused = _exec(funded["name"], "cd /app && flow op run rig-workspace")
    assert refused.returncode == 7, f"{refused.stdout}\n{refused.stderr[-800:]}"
    assert "not been approved" in refused.stdout + refused.stderr
    approved = _exec(funded["name"], "cd /app && flow op run rig-workspace --approved")
    assert approved.returncode == 0, f"{approved.stdout}\n{approved.stderr[-800:]}"


# ── the wizard on top of the ops ─────────────────────────────────────────────

def test_a_wizard_sequences_ops_into_one_activity_tree(funded):
    """The refactor's whole claim, in a container.

    A Wizard is a sequencer: each step CALLS an op, the op's answer is the step's
    verdict, and the run reports into ONE tree — a root with a child per step —
    rather than a root per call. The fallback pair is in the sequence on
    purpose — the cli op fails, the step continues, the agent op after it
    reaches the goal — so the agent runs under a step's node and not beside it.
    """
    steps = ["git-on-path", "jq-on-path", "cowsay-on-path", "cowsay-on-path-agent"]
    done = _sh(
        "docker", "exec", "-i", funded["name"], "sh", "-c",
        "cd /app && python3 tests/long_tests/compute_op_driver.py --wizard " + " ".join(steps),
        check=False, timeout=1500,
    )
    line = next((l for l in done.stdout.splitlines() if l.startswith("WIZARD ")), "")
    assert line, f"the driver produced no wizard run:\n{done.stdout[-2000:]}\n{done.stderr[-2000:]}"
    run = json.loads(line[len("WIZARD "):])

    assert [s["id"] for s in run["steps"]] == steps
    # The cli op for cowsay does NOT reach the goal (on_fail: continue); the agent
    # op after it does — so the run as a whole is not ok, but the goal holds.
    assert run["steps"][-1]["ok"] is True, run
    # ONE tree: a child per step under a single root, not four roots.
    assert run["children"] == steps, run
    assert run["total"] == len(steps)


def test_kafka_is_reached_by_one_agent_process_with_one_retry(funded):
    """The hardest install here, from nothing, by ONE agent op the CALLER may
    continue ONCE.

    The retry is the caller's: a further turn in the SAME process —
    ``run_op(executor=first.executor)`` — told what the completion check said.
    So every call must name one executor. The op's own check is a round trip
    with a token minted per ask; after the op returns, the same check is asked
    AGAIN from a fresh shell, because a broker that lived only as long as the
    agent's turn is exactly the failure this goal exists to catch.
    """
    row = _drive(funded, "kafka-running", flags="--continue 1")["kafka-running"]
    calls = row.get("calls", [])
    # The WHOLE row: when the op raises, the driver's only record of it is `error`.
    print("kafka-running:", json.dumps(row, indent=1))
    assert "error" not in row, f"the op raised instead of answering: {row['error']}"

    assert 1 <= len(calls) <= 2, f"one turn plus at most one continuation: {calls}"
    assert len({c["executor"] for c in calls}) == 1, f"a continuation must prompt the SAME process: {calls}"
    assert row["ok"], f"kafka was not reached: {row.get('detail')}"

    time.sleep(10)
    spec = json.loads((REPO / "tests/long_tests/compute_ops/kafka-running/compute_op.json").read_text())
    again = _exec(funded["name"], spec["completion_check"]["commands"]["linux"])
    assert again.returncode == 0, f"the broker did not outlive the op:\n{again.stdout[-800:]}\n{again.stderr[-800:]}"
