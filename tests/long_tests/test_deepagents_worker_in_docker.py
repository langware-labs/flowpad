"""The builtin worker on the box it exists for: FlowPad, an LLM endpoint, and NOTHING else.

A clean container of ``docker/Dockerfile.bare`` — no Node, no npm, none of the four harness
CLIs (the image asserts that at build time), no volumes, no keychain, no vendor login. The only
funding is an OpenRouter key stored through the product's own two routes (``lm_keys`` →
``llm-endpoint/select``), pinned to ``z-ai/glm-5.3``. So a turn that completes can only have been
run by the hidden ``deepagents`` vendor, and a claude-funded run cannot be mistaken for it: there
is no claude.

Two claims, weakest to strongest:

1. A plain ``AgenticProcess(worker_type="deepagents")`` answers a prompt that needs a real tool
   call, and its transcript names GLM.
2. The BUILTIN path needs no one to choose it: with no harness installed, a capability install
   resolves to the bootstrap worker on its own (``resolve_builtin_worker_type``).

Needs docker and ``OPENROUTER_API_KEY`` (env or ``.env.local``); skips otherwise.
"""

from __future__ import annotations

import json
import os
import shutil
import socket
import subprocess
import time
import uuid
from pathlib import Path

import httpx
import pytest

from tests.long_tests.conftest import _openrouter_key

REPO = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("FLOWPAD_BARE_DOCKER_IMAGE", "flowpad-backend:bare-test")
MODEL = "z-ai/glm-5.3"
pytestmark = [pytest.mark.timeout(900)]  # a cold image build + a fresh container's first turn; do not increase without approval


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _sh(*args: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def _py(name: str, script: str) -> str:
    """Run a Python script inside the container (``-i`` so the heredoc reaches it)."""
    proc = _sh("docker", "exec", "-i", name, "python", "-", input=script, check=False)
    assert proc.returncode == 0, f"in-container script failed:\n{proc.stdout[-1500:]}\n{proc.stderr[-2500:]}"
    return proc.stdout


@pytest.fixture(scope="module")
def container():
    if shutil.which("docker") is None or _sh("docker", "info", check=False).returncode != 0:
        pytest.skip("docker is not available")
    key = _openrouter_key()
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set (env or .env.local)")
    if os.environ.get("FLOWPAD_BARE_DOCKER_REBUILD") or _sh("docker", "image", "inspect", IMAGE, check=False).returncode != 0:
        build = _sh("docker", "build", "-f", "docker/Dockerfile.bare", "-t", IMAGE, ".", cwd=REPO, check=False)
        assert build.returncode == 0, f"image build failed:\n{build.stdout[-1500:]}\n{build.stderr[-3000:]}"
    name, port = f"flowpad-bare-{uuid.uuid4().hex[:6]}", _free_port()
    _sh("docker", "run", "-d", "--name", name, "-p", f"{port}:{port}", "-e", f"LOCAL_SERVER_PORT={port}",
        "-e", "IS_SANDBOX=1", "-e", "MINIHUB_RELOAD=False", IMAGE)
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
            pytest.fail(f"backend in {name} did not come up:\n{_sh('docker', 'logs', name, check=False).stderr[-2500:]}")
        yield {"name": name, "base": base, "port": port, "key": key}
    finally:
        _sh("docker", "rm", "-f", name, check=False)


@pytest.fixture(scope="module")
def funded(container):
    """The product's own two routes, then GLM 5.3 for every tier (``Capability.model_map``)."""
    c = container
    r = httpx.post(f"{c['base']}/api/v1/graph/compute_node/@local/lm_keys", json={"provider": "openrouter", "key": c["key"]}, timeout=60)
    assert r.status_code == 200 and (r.json().get("data") or {}).get("valid") is True, r.text[:300]
    r = httpx.post(f"{c['base']}/api/v1/graph/compute_node/@local/llm-endpoint/select",
                   json={"harness": "deepagents", "kind": "api_key", "provider": "openrouter"}, timeout=60)
    assert r.status_code == 200, r.text[:400]
    out = _py(c["name"], f'''
import asyncio
from flow_sdk.builtin.capability import Capability
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
async def main():
    cap = await Capability.get_by_kind(worker_capability_kind("deepagents"))
    cap.model_map = {{"openrouter": {{t: "{MODEL}" for t in ("sm", "md", "lg")}}}}
    await cap.save()
    print(cap.auth_mode, cap.api_provider)
asyncio.run(main())
''')
    assert out.split()[-2:] == ["api", "openrouter"], out
    return c


def test_the_box_has_no_harness_but_the_builtin_one(container):
    """The premise, re-checked on the RUNNING container and through the product's own install gate."""
    c = container
    found = _sh("docker", "exec", c["name"], "sh", "-c",
                "for b in claude codex copilot opencode node npm; do command -v $b; done; true").stdout.strip()
    assert found == "", f"the bare image is not bare: {found}"

    out = _py(c["name"], '''
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_bin_folder
from flow_sdk.flowpad_types.vendors import VENDORS
print({v.key: worker_bin_folder(v.key) is not None for v in VENDORS})
''')
    installed = eval(out.strip().splitlines()[-1])  # noqa: S307 — a dict literal our own script printed
    assert installed == {"claude": False, "codex": False, "copilot": False, "opencode": False, "deepagents": True}

    harnesses = httpx.get(f"{c['base']}/api/v1/graph/bootstrap", timeout=60).text
    assert "harness.deepagents.cli" not in harnesses, "the hidden vendor leaked into the bootstrap payload"


def test_a_deepagents_process_answers_with_a_real_tool_call_on_glm(funded):
    c = funded
    token = f"BARE-{uuid.uuid4().hex[:8].upper()}"
    out = _py(c["name"], f'''
import asyncio, json, os, tempfile
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
async def main():
    workdir = tempfile.mkdtemp()
    open(os.path.join(workdir, "secret.txt"), "w").write("{token}\\n")
    p = await AgenticProcess(worker_type=WorkerType.DEEPAGENTS, workdir=workdir, pty_mode=False, visible=False,
                             cli_config={{"model": "lg"}}).save()
    r = await p.prompt("Run the shell command `cat secret.txt` and reply with exactly what it printed.")
    await p.wait()
    fresh = await AgenticProcess.get_by_id(p.id)
    path = fresh.driver.transcript_path(fresh)
    events = [json.loads(l) for l in open(path)]
    print("RESULT " + json.dumps({{
        "worker_type": str(fresh.worker_type), "status": str(fresh.status),
        "types": [e["type"] for e in events],
        "model": next(e.get("model") for e in events if e["type"] == "init"),
        "tools": [e["name"] for e in events if e["type"] == "tool_call"],
        "text": " ".join(e["text"] for e in events if e["type"] == "text"),
        "is_error": events[-1].get("is_error"),
    }}))
asyncio.run(main())
''')
    result = json.loads(next(line for line in out.splitlines() if line.startswith("RESULT "))[7:])
    assert "deepagents" in result["worker_type"].lower()
    assert result["model"] == MODEL, "the turn must have run on GLM 5.3 through the stored OpenRouter endpoint"
    assert "execute" in result["tools"], f"no real shell tool call: {result['types']}"
    assert token in result["text"], f"the answer did not come from the file: {result['text'][:300]}"
    assert result["types"][-1] == "result" and result["is_error"] is False

    # No harness CLI ever ran — there is none — and the runner is what did.
    procs = _sh("docker", "exec", c["name"], "sh", "-c", "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '").stdout
    assert " claude " not in f" {procs} "


def test_a_builtin_install_picks_the_bootstrap_worker_by_itself(funded):
    """Nobody names the worker here: with no harness installed, the builtin path resolves to it."""
    out = _py(funded["name"], '''
import asyncio
from flow_sdk.core.capabilities.registry import bootstrap_worker_type, resolve_builtin_worker_type
async def main():
    print("BUILTIN", bootstrap_worker_type(), await resolve_builtin_worker_type())
asyncio.run(main())
''')
    assert next(line for line in out.splitlines() if line.startswith("BUILTIN")).split()[1:] == ["deepagents", "deepagents"]


# ── the bootstrap: the builtin worker installs and enables a REAL harness ─────────────────────

BOOTSTRAP_INSTRUCTION = """\
You are running inside a fresh Linux container that has FlowPad and NO coding-agent CLI.
Do these three things in order, verifying each before moving on. Work autonomously; nobody is
watching and nobody will answer a question.

1. INSTALL the Claude Code CLI. The official installer is:
       curl -fsSL https://claude.ai/install.sh | bash
   `claude --version` must succeed from a brand-new login shell. If the installer puts the binary
   somewhere that is not on the default PATH, link it into /usr/local/bin.

2. ENABLE it in FlowPad. The backend is at http://localhost:{port}.
   a. Make FlowPad notice the install: GET /api/v1/graph/capability?include_system=true, find the
      row whose kind is "harness.claude.cli", then POST /api/v1/graph/capability/<its id>/test and
      confirm it now reports available.
   b. Fund it from this box's LLM endpoint: `flow llm list` shows the sources; make the OpenRouter
      key source the claude harness's funding with `flow llm user use <row number> claude`.

3. LAUNCH a FlowPad agentic process that runs on the claude worker, as proof the install works:
       POST /api/v1/graph/agentic_process
            {{"worker_type": "claude_code", "workdir": "/tmp/claude-proof", "pty_mode": false,
              "cli_config": {{"model": "{model}"}}}}
   (create the workdir first), then
       POST /api/v1/graph/agentic_process/<id>/prompt   {{"message": "Reply with exactly: {token}"}}
   The response streams. Confirm the claude worker's reply contains {token}.

Finish with a short report of what you did and the id of the claude process.
"""


def test_the_builtin_worker_installs_claude_funds_it_and_launches_a_claude_process(funded):
    """The whole reason the builtin worker exists, end to end and with nobody helping it:
    a deepagents process on GLM is TOLD to install Claude Code, enable it against this box's LLM
    endpoint, and launch a claude-based agentic process — which can only work because of its own
    install. The test then checks evidence the agent cannot talk its way to."""
    c = funded
    token = f"BOOT-{uuid.uuid4().hex[:8].upper()}"
    assert _sh("docker", "exec", c["name"], "sh", "-c", "command -v claude; true").stdout.strip() == "", "claude must start ABSENT"

    instruction = BOOTSTRAP_INSTRUCTION.format(port=c["port"], model=MODEL, token=token)
    _sh("docker", "exec", "-i", c["name"], "sh", "-c", "cat > /tmp/bootstrap_instruction.txt", input=instruction)
    out = _py(c["name"], '''
import asyncio, json, tempfile
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.flowpad_types.enums.worker_enums import WorkerType
async def main():
    p = await AgenticProcess(worker_type=WorkerType.DEEPAGENTS, workdir=tempfile.mkdtemp(), visible=False,
                             cli_config={"model": "lg"}, name="Bootstrap: install + enable claude").save()
    await p.prompt(open("/tmp/bootstrap_instruction.txt").read())
    await p.wait()
    fresh = await AgenticProcess.get_by_id(p.id)
    events = [json.loads(l) for l in open(fresh.driver.transcript_path(fresh))]
    print("INSTALLER " + json.dumps({
        "id": p.id, "last": events[-1]["type"], "is_error": events[-1].get("is_error"),
        "tool_calls": sum(1 for e in events if e["type"] == "tool_call"),
        "duration_s": round((events[-1].get("duration_ms") or 0) / 1000),
        "report": " ".join(e["text"] for e in events if e["type"] == "text")[-700:],
    }))
asyncio.run(main())
''')
    installer = json.loads(next(line for line in out.splitlines() if line.startswith("INSTALLER "))[10:])
    print(f"\ninstaller turn: {installer['tool_calls']} tool calls, {installer['duration_s']}s\n{installer['report']}")
    assert installer["last"] == "result" and installer["is_error"] is False, installer

    # 1. installed — and findable the way a fresh login shell finds it
    version = _sh("docker", "exec", c["name"], "bash", "-lc", "claude --version", check=False)
    assert version.returncode == 0 and "Claude Code" in version.stdout, f"claude is not runnable: {version.stdout} {version.stderr}"

    # 2 + 3. enabled and PROVEN — read from the product, in a fresh process (no cached discovery)
    proof = _py(c["name"], f'''
import asyncio, json
from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind, worker_is_installed
from flow_sdk.builtin.capability import Capability
async def main():
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    rows = [r for r in await AgenticProcess.get_all() if str(r.worker_type).endswith("claude_code")]
    answers = []
    for r in rows:
        # The token is in the PROMPT too, so only an ASSISTANT frame counts as claude answering.
        chat = [str(fd.flow_value) for fd in r.driver.load_history(r)
                if str((fd.attributes or {{}}).get("element-type")) == "chat"]
        transcript = r.driver.transcript_path(r)
        models = sorted({{(json.loads(l).get("message") or {{}}).get("model") for l in open(transcript)
                         if l.strip().startswith("{{")}} - {{None}}) if transcript else []
        answers.append({{"id": r.id, "has_token": any("{token}" in c for c in chat), "models": models,
                        "transcript": str(transcript)}})
    print("PROOF " + json.dumps({{"installed": worker_is_installed("claude"), "auth_mode": cap.auth_mode,
                                 "api_provider": cap.api_provider, "claude_processes": answers}}))
asyncio.run(main())
''')
    result = json.loads(next(line for line in proof.splitlines() if line.startswith("PROOF "))[6:])
    assert result["installed"] is True, "FlowPad's own install gate does not see claude"
    assert (result["auth_mode"], result["api_provider"]) == ("api", "openrouter"), f"claude is not funded by the endpoint: {result}"
    answered = [p for p in result["claude_processes"] if p["has_token"]]
    assert answered, f"no claude-worker ASSISTANT message carries the token — the install did not yield a working worker: {result}"
    # It ran as the real claude CLI (its transcript lives under ~/.claude) on the endpoint's model.
    assert "/.claude/" in answered[0]["transcript"], answered
    assert MODEL in answered[0]["models"], f"claude did not run on the endpoint's model: {answered}"
    print(f"claude worker answered on {answered[0]['models']} — transcript {answered[0]['transcript']}")
