"""Variant B of ``docs/snippets/agents-on-channels.md`` runs in Docker and answers WhatsApp.

A clean container of this tree's backend image, no volumes, no keychain, no Anthropic login:
the claude harness is funded by an OpenRouter key through the product's own two routes
(``lm_keys`` → ``llm-endpoint/select``) and pinned to haiku, so a real model turn runs — and a
device-funded one cannot be mistaken for it. The WhatsApp provider is the driver's own ``Double``
hosted INSIDE the container (``tests/e2e/channel_doubles.py --channels whatsapp --no-plant``); the
agent is set up by the snippet ALONE (§1 + §3 of the page, assembled into one script). A customer
writes in through the webhook; the loop spawns the agent; the reply leaves through the channel.

Needs docker and ``OPENROUTER_API_KEY`` in the environment or ``.env.local``; skips otherwise.
The first turn pays for the CLI's cold start in a fresh container.
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
IMAGE = os.environ.get("FLOWPAD_DOCKER_IMAGE", "flowpad-backend:snippet-test")
pytestmark = [pytest.mark.timeout(900)]  # a fresh container's first model turn; do not increase without approval


def _openrouter_key() -> str:
    key = os.environ.get("OPENROUTER_API_KEY", "")
    if not key and (REPO / ".env.local").is_file():
        match = re.search(r"^OPENROUTER_API_KEY=(.+)$", (REPO / ".env.local").read_text(), re.M)
        key = match.group(1).strip().strip("'\"") if match else ""
    return key


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _sh(*args: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def _exec(name: str, script: str, *, detach: bool = False) -> str:
    """``sh -c script`` inside the container (``-i`` so a heredoc reaches it)."""
    if detach:
        _sh("docker", "exec", "-d", name, "sh", "-c", script)
        return ""
    return _sh("docker", "exec", "-i", name, "sh", "-c", script).stdout


def snippet_script() -> str:
    """§1 + §3 of the page as one script, values from the environment: the snippet, nothing else."""
    page = (REPO / "docs/snippets/agents-on-channels.md").read_text(encoding="utf-8")
    fences = re.findall(r"```python\n(.*?)```", page, re.S)
    credential, loop = fences[0], fences[2]
    body = "".join(("    " + line if line.strip() else line) for line in (credential + "\n" + loop).splitlines(True))
    return (
        "import asyncio, json, os\n"
        "WHATSAPP_TOKEN = os.environ['WHATSAPP_TOKEN']\nWHATSAPP_APP_SECRET = os.environ['WHATSAPP_APP_SECRET']\n"
        "PHONE_NUMBER_ID = os.environ['PHONE_NUMBER_ID']\nVERIFY_TOKEN = os.environ['VERIFY_TOKEN']\n"
        "CUSTOMER = os.environ['CUSTOMER']\nEXTRA_CONFIG = json.loads(os.environ.get('EXTRA_CONFIG') or '{}')\n\n"
        f"async def main():\n{body}\n\nasyncio.run(main())\n"
    )


@pytest.fixture(scope="module")
def container(tmp_path_factory):
    if shutil.which("docker") is None or _sh("docker", "info", check=False).returncode != 0:
        pytest.skip("docker is not available")
    key = _openrouter_key()
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set (env or .env.local)")
    if _sh("docker", "image", "inspect", IMAGE, check=False).returncode != 0:
        _sh("docker", "build", "-f", "docker/Dockerfile.flow-backend", "-t", IMAGE, ".", cwd=REPO)
    name, port = f"flowpad-snippet-{uuid.uuid4().hex[:6]}", _free_port()
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
            pytest.fail(f"backend in {name} did not come up:\n{_sh('docker', 'logs', name, check=False).stderr[-2000:]}")
        yield {"name": name, "base": base, "port": port, "key": key}
    finally:
        _sh("docker", "rm", "-f", name, check=False)


def _fund_claude_with_openrouter(c: dict) -> None:
    """The product's own two routes, then haiku for every tier (``Capability.model_map``)."""
    r = httpx.post(f"{c['base']}/api/v1/graph/compute_node/@local/lm_keys", json={"provider": "openrouter", "key": c["key"]}, timeout=60)
    assert r.status_code == 200 and (r.json().get("data") or {}).get("valid") is True, r.text[:300]
    r = httpx.post(f"{c['base']}/api/v1/graph/compute_node/@local/llm-endpoint/select",
                   json={"harness": "claude", "kind": "api_key", "provider": "openrouter"}, timeout=60)
    assert r.status_code == 200, r.text[:300]
    out = _sh("docker", "exec", "-i", c["name"], "python", "-", input='''
import asyncio
from flow_sdk.builtin.capability import Capability
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
async def main():
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    cap.model_map = {"openrouter": {t: "anthropic/claude-haiku-4.5" for t in ("sm", "md", "lg")}}
    await cap.save()
    print(cap.auth_mode, cap.api_provider)
asyncio.run(main())
''').stdout
    assert out.split() == ["api", "openrouter"], out


def _start_whatsapp_double(c: dict) -> dict:
    """The driver's Double inside the container; returns its ``/channels`` entry (values included)."""
    _sh("docker", "cp", str(REPO / "tests"), f"{c['name']}:/app/tests")
    _exec(c["name"], "python -c 'import pytest, httpx' 2>/dev/null || uv pip install --system -q pytest httpx")
    _exec(c["name"], f"cd /app && python tests/e2e/channel_doubles.py --backend http://localhost:{c['port']} --channels whatsapp --no-plant > /tmp/doubles.log 2>&1", detach=True)
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        log = _exec(c["name"], "cat /tmp/doubles.log")
        if '"control"' in log:
            control = json.loads(next(line for line in log.splitlines() if "\"control\"" in line))["control"]
            _exec(c["name"], f"echo {control} > /tmp/control")
            return json.loads(_exec(c["name"], f"curl -s {control}/channels"))["whatsapp"]
        time.sleep(0.5)
    pytest.fail(f"the WhatsApp double did not start:\n{log[-1500:]}")


def _control(c: dict, method: str, route: str, body: dict | None = None) -> str:
    data = f"-H 'Content-Type: application/json' -d '{json.dumps(body)}'" if body is not None else ""
    return _exec(c["name"], f"curl -s -X {method} $(cat /tmp/control){route} {data}")


def test_the_snippet_alone_puts_an_agent_on_whatsapp_and_it_answers(container):
    c = container
    _fund_claude_with_openrouter(c)
    channel = _start_whatsapp_double(c)

    # The snippet, with the values a person would have: the credential's secrets, the business
    # number's id, the verify token, the customer who may write in. EXTRA_CONFIG points the driver
    # at the loopback Graph; it is empty in production.
    env = {
        "WHATSAPP_TOKEN": channel["secrets"]["access_token"], "WHATSAPP_APP_SECRET": channel["secrets"]["app_secret"],
        "PHONE_NUMBER_ID": channel["config"]["phone_number_id"], "VERIFY_TOKEN": channel["config"]["verify_token"],
        "CUSTOMER": channel["sender"], "EXTRA_CONFIG": json.dumps({"base_url": channel["config"]["base_url"]}),
    }
    _sh("docker", "exec", "-i", c["name"], "sh", "-c", "cat > /app/run_whatsapp_agent.py", input=snippet_script())
    exports = " ".join(f"{k}='{v}'" for k, v in env.items())
    _exec(c["name"], f"cd /app && {exports} python run_whatsapp_agent.py > /tmp/agent.log 2>&1", detach=True)

    # The customer writes in once the loop has made its source (the webhook needs a row to land on).
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        rows = httpx.get(f"{c['base']}/api/v1/graph/data_source", timeout=10).json().get("data") or []
        if any(r.get("provider") == "whatsapp" for r in rows):
            break
        time.sleep(1)
    else:
        pytest.fail(f"the snippet made no source:\n{_exec(c['name'], 'tail -30 /tmp/agent.log')}")
    order = f"ZX-{uuid.uuid4().hex[:5].upper()}"
    delivered = json.loads(_control(c, "POST", "/deliver", {"channel": "whatsapp", "text": f"Hello, my order {order} arrived with a cracked screen. What should I do?"}))
    assert delivered.get("webhook_status") == 200, delivered

    # A real model turn: the reply names the order and is not the question echoed back.
    deadline = time.monotonic() + 600
    while time.monotonic() < deadline:
        sent = json.loads(_control(c, "GET", "/sent?channel=whatsapp") or "[]")
        if any(order in (m.get("text") or "") for m in sent):
            break
        time.sleep(5)
    else:
        pytest.fail(f"no reply left through WhatsApp:\n{_exec(c['name'], 'tail -40 /tmp/agent.log')}")
    (reply,) = [m for m in sent if order in (m.get("text") or "")]
    assert reply["to"] == channel["sender"] and reply["thread"] == delivered["external_id"]
    assert "cracked screen. What should I do?" not in reply["text"], "the reply is an answer, not the question"
    assert rows and str(rows[0].get("owner") or "").startswith("agent-"), "the source is the agent's"
