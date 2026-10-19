"""Both variants of ``docs/snippets/agents-on-channels.md`` run in Docker and answer WhatsApp.

A clean container of this tree's backend image, no volumes, no keychain, no Anthropic login:
the claude harness is funded by an OpenRouter key through the product's own two routes
(``lm_keys`` → ``llm-endpoint/select``) and pinned to haiku, so a real model turn runs — and a
device-funded one cannot be mistaken for it. The WhatsApp provider is the driver's own ``Double``
hosted INSIDE the container (``tests/e2e/channel_doubles.py --channels whatsapp --no-plant``), and the
driver's own API root (``GRAPH_API_BASE``) points at it — what ``point_driver_at`` does in the unit
tests, done to the driver's file so every process in the container sees it; the
agent is set up by the snippet ALONE (§1 + §2 for variant A, §1 + §3 for variant B, assembled into
one script). A customer writes in through the webhook; the backend's runner (A) or the script's loop
(B) spawns the agent; the reply leaves through the channel.

Needs docker and ``OPENROUTER_API_KEY`` in the environment or ``.env.local``; skips otherwise.
``FLOWPAD_SNIPPET_KEEP=1`` keeps the container for inspection.
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


def snippet_script(variant: str, *, credential: bool) -> str:
    """§1 + §2 (A) or §1 + §3 (B) of the page as one script, values from the environment: the snippet,
    nothing else. §1 is "once": the second variant on the same machine runs without it."""
    page = (REPO / "docs/snippets/agents-on-channels.md").read_text(encoding="utf-8")
    fences = re.findall(r"```python\n(.*?)```", page, re.S)
    parts = ([fences[0]] if credential else []) + [fences[{"A": 1, "B": 2}[variant]]]
    body = "".join(("    " + line if line.strip() else line) for line in "\n".join(parts).splitlines(True))
    return (
        "import asyncio, os\n"
        "WHATSAPP_TOKEN = os.environ['WHATSAPP_TOKEN']\nWHATSAPP_APP_SECRET = os.environ['WHATSAPP_APP_SECRET']\n"
        "PHONE_NUMBER_ID = os.environ['PHONE_NUMBER_ID']\nVERIFY_TOKEN = os.environ['VERIFY_TOKEN']\n"
        "CUSTOMER = os.environ['CUSTOMER']\n\n"
        f"async def main():\n{body}\n\nasyncio.run(main())\n"
    )


@pytest.fixture(scope="module")
def container(tmp_path_factory):
    if shutil.which("docker") is None or _sh("docker", "info", check=False).returncode != 0:
        pytest.skip("docker is not available")
    key = _openrouter_key()
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set (env or .env.local)")
    # Always build: the image must be THIS tree (layer cache keeps a no-change rebuild quick). Building
    # only when the tag was missing ran a weeks-old image against today's snippet.
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
        if not os.environ.get("FLOWPAD_SNIPPET_KEEP"):
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
            channel = json.loads(_exec(c["name"], f"curl -s {control}/channels"))["whatsapp"]
            _point_driver_at(c, "whatsapp", "GRAPH_API_BASE", channel["config"]["base_url"])
            return channel
        time.sleep(0.5)
    pytest.fail(f"the WhatsApp double did not start:\n{log[-1500:]}")


def _point_driver_at(c: dict, provider: str, root: str, url: str) -> None:
    """``tests.utils.snippets.point_driver_at`` for a container: the snippet passes no API root (it is
    the published contract), so the driver's own constant is pointed at the double — in its file, in
    both copies a process here may import (``/app`` for anything started from there, site-packages for
    the rest), before the snippet or the deployment process it starts first imports it."""
    rel = f"flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver/{provider}/source.py"
    site = _exec(c["name"], "cd / && python -c 'import flow_sdk, os; print(os.path.dirname(os.path.dirname(flow_sdk.__file__)))'").strip()
    for path in (f"/app/{rel}", f"{site}/{rel}"):
        _exec(c["name"], f"sed -i 's|^{root} = .*|{root} = \"{url}\"|' {path} && grep -q '^{root} = \"{url}\"' {path}")


def _control(c: dict, method: str, route: str, body: dict | None = None) -> str:
    data = f"-H 'Content-Type: application/json' -d '{json.dumps(body)}'" if body is not None else ""
    return _exec(c["name"], f"curl -s -X {method} $(cat /tmp/control){route} {data}")


@pytest.fixture(scope="module")
def rig(container):
    _fund_claude_with_openrouter(container)
    return {**container, "channel": _start_whatsapp_double(container), "credential_declared": False}


@pytest.mark.parametrize("variant", ["A", "B"])
def test_the_snippet_alone_puts_an_agent_on_whatsapp_and_it_answers(rig, variant):
    c, channel = rig, rig["channel"]
    # One variant at a time on the double's one business number: the earlier variant's source goes.
    for row in httpx.get(f"{c['base']}/api/v1/graph/data_source", timeout=10).json().get("data") or []:
        httpx.delete(f"{c['base']}/api/v1/graph/data_source/{row['id']}", timeout=10)
    # The image has no pkill: walk /proc, skipping this shell (its own cmdline names the script too).
    _exec(c["name"], "for p in /proc/[0-9]*; do pid=$(basename $p); [ \"$pid\" = \"$$\" ] && continue; "
                     "grep -q run_whatsapp_agent $p/cmdline 2>/dev/null && kill $pid; done; true")

    # The snippet, with the values a person would have: the credential's secrets, the business
    # number's id, the verify token, the customer who may write in.
    env = {
        "WHATSAPP_TOKEN": channel["secrets"]["access_token"], "WHATSAPP_APP_SECRET": channel["secrets"]["app_secret"],
        "PHONE_NUMBER_ID": channel["config"]["phone_number_id"], "VERIFY_TOKEN": channel["config"]["verify_token"],
        "CUSTOMER": channel["sender"],
    }
    script = snippet_script(variant, credential=not c["credential_declared"])
    c["credential_declared"] = True
    _sh("docker", "exec", "-i", c["name"], "sh", "-c", "cat > /app/run_whatsapp_agent.py", input=script)
    exports = " ".join(f"{k}='{v}'" for k, v in env.items())
    _exec(c["name"], f"cd /app && {exports} python -u run_whatsapp_agent.py > /tmp/agent.log 2>&1", detach=True)

    # The customer writes in once the snippet has made its source (the webhook needs a row to land
    # on). Variant A's script has exited by then; variant B's is the loop that stays up.
    deadline = time.monotonic() + 60
    while time.monotonic() < deadline:
        rows = [r for r in httpx.get(f"{c['base']}/api/v1/graph/data_source", timeout=10).json().get("data") or [] if r.get("provider") == "whatsapp"]
        if rows and (variant == "B" or rows[0].get("status") == "active"):
            break
        time.sleep(1)
    else:
        pytest.fail(f"the snippet made no {'active ' if variant == 'A' else ''}source:\n{_exec(c['name'], 'tail -30 /tmp/agent.log')}")
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
    # To the person who wrote, in their chat; quoting nothing — a 1:1 answer quotes the message only
    # when the person wrote again before it went out (``Delivered.reply_spec``, quote=None).
    assert reply["to"] == channel["sender"] and reply["thread"] is None, reply
    assert "cracked screen. What should I do?" not in reply["text"], "the reply is an answer, not the question"
    assert str(rows[0].get("owner") or "").startswith("agent-"), "the source is the agent's"
    if variant == "A":
        assert rows[0].get("allowed_senders") == [channel["sender"]], "the source carries the allowlist the runner gates on"
        assert "run_whatsapp_agent" not in _exec(c["name"], "cat /proc/[0-9]*/cmdline 2>/dev/null | tr '\\0' ' '"), "nothing of the snippet's stays running: the backend answered"
