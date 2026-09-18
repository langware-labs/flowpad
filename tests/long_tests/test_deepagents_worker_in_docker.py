"""The builtin worker on the box it exists for: FlowPad, an LLM endpoint, and NOTHING else.

A clean container of ``docker/Dockerfile.bare-py312`` — no Node, no npm, none of the four harness
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
IMAGE = os.environ.get("FLOWPAD_BARE_DOCKER_IMAGE", "flowpad-backend:bare-py312-test")
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
        build = _sh("docker", "build", "-f", "docker/Dockerfile.bare-py312", "-t", IMAGE, ".", cwd=REPO, check=False)
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
