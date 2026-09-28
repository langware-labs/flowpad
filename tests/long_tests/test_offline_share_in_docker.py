"""Offline sharing between two isolated machines: every asset type arrives intact AND works.

Two clean containers of this tree's backend image — no shared volume, no shared
network, no hub. The only thing that crosses between them is the ``.flowmsg`` file,
carried by the host:

  A (sender)    a project holding one asset of each type → ``flow-message-export``
                packs ALL of them into ONE message → the file leaves.
  B (receiver)  an empty project → ``flow-message-upload`` stages the file →
                ``flow_message/<id>/install-attachments`` files it into the project.

Per type, B must hold the asset at the sender's canonical place, indexed with the
SAME id and the same shared props, filed under B's project — and the asset must be
ALIVE on B: a real model turn (claude, haiku through B's own LLM endpoint, funded
by an OpenRouter key via ``lm_keys`` → ``llm-endpoint/select``) has to use it. Each
asset carries a per-run word that appears nowhere but in that asset, so an answer
containing it cannot come from the prompt.

  skill      a claude turn in B's project invokes it and says its word
  subagent   a claude turn delegates to it and returns its word
  agent      ``agent/<id>/run`` answers with its system prompt's word…
  mcp        …and with the word its bundled MCP tool returns (the agent names the
             MCP by TypeId, so the reference survives only if the id did);
             ``mcp/<id>/test`` lists the tool
  doc        full-text search on B finds it by its word
  data_driver + credential   a renamed copy of a shipped driver loads on B (no ``load_error``); the
             credential is declared

Needs docker and ``OPENROUTER_API_KEY`` (env or ``.env.local``); skips otherwise.
``FLOWPAD_OP_KEEP=1`` keeps both containers for inspection.
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

from tests.long_tests.conftest import _openrouter_key

REPO = Path(__file__).resolve().parents[2]
IMAGE = os.environ.get("FLOWPAD_DOCKER_IMAGE", "flowpad-backend:offline-share")
#: A shipped message driver with a named credential, copied and renamed into the sender project: what an
#: external connector looks like (WAHA itself is one now — it lives in its own project).
SHIPPED = REPO / "flow_sdk/system_projects/flowpad_assistant/agentic-assets"
DRIVER = "telegram"
pytestmark = [pytest.mark.timeout(900)]  # two fresh containers + four model turns; do not increase without approval

SENDER, RECEIVER = "/root/sender", "/root/receiver"
_CLOCKS = {"created_date", "updated_date", "content_digest", "indexed_at", "last_indexed_at"}


def _sh(*args: str, check: bool = True, **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, check=check, capture_output=True, text=True, **kw)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def _py(c: dict, script: str) -> dict:
    """Run ``script`` with the container's python; it prints one ``RESULT <json>`` line."""
    out = _sh("docker", "exec", "-i", c["name"], "python", "-", input=script, check=False)
    for line in out.stdout.splitlines():
        if line.startswith("RESULT "):
            return json.loads(line[len("RESULT "):])
    raise AssertionError(f"no RESULT from {c['name']}:\n{out.stdout[-1500:]}\n{out.stderr[-3000:]}")


def _cli(c: dict, cmd: str) -> dict:
    """A ``flow`` command in the container; its JSON envelope (exit code kept)."""
    out = _sh("docker", "exec", c["name"], "sh", "-c", cmd, check=False)
    start = out.stdout.find("{")
    body = json.loads(out.stdout[start:]) if start >= 0 else {}
    return {"code": out.returncode, "body": body, "raw": out.stdout + out.stderr}


def _api(c: dict, method: str, route: str, **kw) -> dict:
    r = httpx.request(method, f"{c['base']}/api/v1/{route}", timeout=kw.pop("timeout", 120), **kw)
    assert r.status_code == 200, f"{method} {route} → {r.status_code}: {r.text[:800]}"
    return r.json().get("data") or {}


def _start(label: str) -> dict:
    name, port = f"flowpad-share-{label}-{uuid.uuid4().hex[:6]}", _free_port()
    _sh("docker", "run", "-d", "--name", name, "-p", f"{port}:{port}", "-e", f"LOCAL_SERVER_PORT={port}",
        "-e", "IS_SANDBOX=1", "-e", "MINIHUB_RELOAD=False", IMAGE)
    base = f"http://localhost:{port}"
    deadline = time.monotonic() + 120
    while time.monotonic() < deadline:
        try:
            if httpx.get(f"{base}/api/v1/health/status", timeout=2).status_code == 200:
                return {"name": name, "base": base, "port": port}
        except httpx.HTTPError:
            pass
        time.sleep(1)
    logs = _sh("docker", "logs", name, check=False)
    _sh("docker", "rm", "-f", name, check=False)
    pytest.fail(f"backend in {name} did not come up:\n{logs.stderr[-2000:]}")


@pytest.fixture(scope="module")
def machines():
    if shutil.which("docker") is None or _sh("docker", "info", check=False).returncode != 0:
        pytest.skip("docker is not available")
    key = _openrouter_key()
    if not key:
        pytest.skip("OPENROUTER_API_KEY is not set (env or .env.local)")
    # Always build: the image must be THIS tree (layer cache keeps a no-change rebuild quick).
    _sh("docker", "build", "-f", "docker/Dockerfile.flow-backend", "-t", IMAGE, ".", cwd=REPO)
    started: list[dict] = []
    try:
        a = _start("a")
        started.append(a)
        b = _start("b")
        started.append(b)
        b["key"] = key
        yield a, b
    finally:
        if not os.environ.get("FLOWPAD_OP_KEEP"):
            for c in started:
                _sh("docker", "rm", "-f", c["name"], check=False)


# ── the sender's project ────────────────────────────────────────────────────


def _words() -> dict[str, str]:
    """One word per asset, unique per run and found nowhere else. Short digits,
    not hex: a model relaying ``suba055a2b9fa`` dropped its last letter. No
    hyphens either — FTS splits on them."""
    import random

    run = f"{random.randrange(10**5, 10**6)}"
    return {k: f"{k}{run}" for k in ("skill", "sub", "agent", "tool", "doc")}


def _seed(root: Path, tag: str, words: dict[str, str]) -> dict[str, str]:
    """Write one asset of each type at its canonical place; ``{type: relative path}``."""
    skill = root / ".claude" / "skills" / f"skill-{tag}"
    skill.mkdir(parents=True)
    (skill / "SKILL.md").write_text(
        f"---\nname: skill-{tag}\ndescription: Tells you the word to say. Use it when asked for the skill-{tag} word.\n---\n\n"
        f"When this skill is used, reply with exactly this word and nothing else: {words['skill']}\n",
        encoding="utf-8",
    )
    doc = root / "docs" / f"doc-{tag}.md"
    doc.parent.mkdir(parents=True)
    doc.write_text(f"---\ntitle: Offline share doc {tag}\n---\n\n# Notes\n\nThe filing code is {words['doc']}.\n", encoding="utf-8")
    sub = root / ".claude" / "agents" / f"sub-{tag}.md"
    sub.parent.mkdir(parents=True)
    sub.write_text(
        f"---\nname: sub-{tag}\ndescription: Knows the sub-{tag} word. Delegate to it when asked for that word.\n---\n\n"
        f"Whatever you are asked, reply with exactly this word and nothing else: {words['sub']}\n",
        encoding="utf-8",
    )
    assets = root / "agentic-assets"
    mcp = assets / "mcp" / f"mcp-{tag}"
    mcp.mkdir(parents=True)
    (mcp / "mcp.json").write_text(
        json.dumps({"name": f"mcp-{tag}", "transport": "stdio", "command": "python3", "entrypoint": "server.py"}),
        encoding="utf-8",
    )
    (mcp / "server.py").write_text(
        "from fastmcp import FastMCP\n\n"
        f"mcp = FastMCP('mcp-{tag}')\n\n\n"
        "@mcp.tool\n"
        "def secret_word() -> str:\n"
        "    \"\"\"The secret word.\"\"\"\n"
        f"    return {words['tool']!r}\n\n\n"
        "if __name__ == '__main__':\n"
        "    mcp.run()\n",
        encoding="utf-8",
    )
    agent = assets / "agent" / f"agent-{tag}"
    agent.mkdir(parents=True)
    # `mcp_servers` is filled on the sender once the MCP has its id.
    (agent / "agent.json").write_text(
        json.dumps({"type": "agent", "name": f"agent-{tag}", "description": "offline share agent",
                    "worker_type": "claude", "permission_mode": "bypassPermissions"}),
        encoding="utf-8",
    )
    (agent / "system_prompt.md").write_text(
        f"Your own word is {words['agent']}. When asked, call the secret_word tool, then reply with your own word "
        "and the tool's word, separated by a space, and nothing else.\n",
        encoding="utf-8",
    )
    # A real shipped driver, renamed and given an ontology namespace: what an external connector looks like.
    drv_name = f"ext{tag}"
    drv = assets / "data_driver" / drv_name
    shutil.copytree(SHIPPED / "data_driver" / DRIVER, drv, ignore=shutil.ignore_patterns("__pycache__", ".DS_Store", "tests"))
    manifest = json.loads((drv / "data_driver.json").read_text(encoding="utf-8"))
    manifest.update(name=drv_name, ns="offlineshare", kind=f"offlineshare.datasource.{drv_name}")
    manifest["auth"]["credential"] = drv_name
    (drv / "data_driver.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")
    source = (drv / "source.py").read_text(encoding="utf-8")
    assert f'provider = "{DRIVER}"' in source
    (drv / "source.py").write_text(source.replace(f'provider = "{DRIVER}"', f'provider = "{drv_name}"'), encoding="utf-8")
    cred = assets / "credential" / drv_name
    cred.mkdir(parents=True)
    body = json.loads((SHIPPED / "credential" / DRIVER / "credential.json").read_text(encoding="utf-8"))
    body["name"] = drv_name
    (cred / "credential.json").write_text(json.dumps(body, indent=2), encoding="utf-8")
    return {
        "skill": str(skill.relative_to(root)),
        "markdown": str(doc.relative_to(root)),
        "subagent": str(sub.relative_to(root)),
        "mcp": str(mcp.relative_to(root)),
        "agent": str(agent.relative_to(root)),
        "data_driver": str(drv.relative_to(root)),
        "credential": str(cred.relative_to(root)),
    }


_ROWS = r'''
import asyncio, json
from pathlib import Path
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.fs_store.schema_registry import SchemaRegistry
ROOT, PLACES, CLOCKS = Path(%(root)r), %(places)r, set(%(clocks)r)
async def main():
    out = {}
    for t, rel in PLACES.items():
        target = (ROOT / rel).resolve()
        for row in await SchemaRegistry.get_entity_cls(t).get_all({}):
            ref = str(getattr(row, "asset_ref", "") or "")
            if ref and target in (Path(ref).resolve(), Path(ref).resolve().parent):
                common = {k: v for k, v in row.to_common_json().items() if k not in CLOCKS}
                out[t] = {"id": row.id, "typeid": str(row.typeid), "project_id": row.project_id,
                          "common": json.loads(json.dumps(common, default=str)),
                          "dump": json.dumps(row.model_dump(mode="json"), default=str)}
                break
    print("RESULT " + json.dumps(out))
asyncio.run(main())
'''


def _rows(c: dict, root: str, places: dict[str, str]) -> dict:
    return _py(c, _ROWS % {"root": root, "places": places, "clocks": sorted(_CLOCKS)})


def _project(c: dict, root: str) -> str:
    _sh("docker", "exec", c["name"], "mkdir", "-p", root)
    created = _api(c, "POST", "graph/project",
                   json={"type": "project", "name": Path(root).name, "fs_storage_mount_path": root})
    return str(created["id"])


def _index(c: dict, path: str) -> None:
    _api(c, "POST", "graph/compute_node/@local/fs-records/index", params={"path": path})


# ── the receiver's LLM and a model turn ─────────────────────────────────────


def _fund(c: dict) -> None:
    """B's own LLM endpoint: the product's two routes, then haiku for every tier."""
    r = httpx.post(f"{c['base']}/api/v1/graph/compute_node/@local/lm_keys",
                   json={"provider": "openrouter", "key": c["key"]}, timeout=60)
    assert r.status_code == 200 and (r.json().get("data") or {}).get("valid") is True, r.text[:300]
    _api(c, "POST", "graph/compute_node/@local/llm-endpoint/select",
         json={"harness": "claude", "kind": "api_key", "provider": "openrouter"})
    got = _py(c, '''
import asyncio, json
from flow_sdk.builtin.capability import Capability
from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import worker_capability_kind
async def main():
    cap = await Capability.get_by_kind(worker_capability_kind("claude"))
    cap.model_map = {"openrouter": {t: "anthropic/claude-haiku-4.5" for t in ("sm", "md", "lg")}}
    await cap.save()
    print("RESULT " + json.dumps([cap.auth_mode, cap.api_provider]))
asyncio.run(main())
''')
    assert got == ["api", "openrouter"], got


def _parse(transcript: str) -> tuple[list[dict], str, bool]:
    """Tool calls, the last assistant text, and whether the turn has ended: the
    last assistant message stopped on ``end_turn`` (this CLI writes no ``result``
    line into the session file)."""
    tools: list[dict] = []
    final, ended = "", False
    for line in transcript.splitlines():
        try:
            event = json.loads(line)
        except ValueError:
            continue
        if event.get("isSidechain"):
            continue
        message = event.get("message") or {}
        if event.get("type") == "user":
            # A tool's answer, attached to the call that asked for it.
            for part in message.get("content") or [] if isinstance(message.get("content"), list) else []:
                if isinstance(part, dict) and part.get("type") == "tool_result":
                    for call in tools:
                        if call["id"] == part.get("tool_use_id"):
                            call["result"] = json.dumps(part.get("content"))
            continue
        if event.get("type") != "assistant":
            continue
        ended = message.get("stop_reason") == "end_turn"
        for part in message.get("content") or []:
            if isinstance(part, dict) and part.get("type") == "tool_use":
                tools.append({"id": part.get("id"), "name": part.get("name"), "input": part.get("input") or {}, "result": ""})
            if isinstance(part, dict) and part.get("type") == "text" and part.get("text"):
                final = part["text"]
    return tools, final, ended


def _turn(c: dict, process_id: str) -> dict:
    """Wait for the process's first turn to end; its tool calls and final text."""
    transcript = ""
    deadline = time.monotonic() + 300
    while time.monotonic() < deadline:
        session = _api(c, "GET", f"graph/agentic_process/{process_id}").get("session_id") or ""
        if session:
            found = _sh("docker", "exec", c["name"], "sh", "-c",
                        f"ls /root/.claude/projects/*/{session}.jsonl 2>/dev/null | head -1", check=False).stdout.strip()
            if found:
                transcript = _sh("docker", "exec", c["name"], "cat", found, check=False).stdout
                tools, final, ended = _parse(transcript)
                if ended:
                    return {"tools": tools, "final": final, "raw": transcript}
        time.sleep(2)
    pytest.fail(f"process {process_id} never finished a turn:\n{transcript[-3000:]}")


def _claude(c: dict, project_id: str, instruction: str) -> dict:
    proc = _api(c, "POST", "graph/agentic_process", json={
        "worker_type": "claude_code", "pty_mode": False, "workdir": RECEIVER, "project_id": project_id,
        "name": "offline-share-alive", "cli_config": {"model": "anthropic/claude-haiku-4.5"},
    })
    _api(c, "POST", f"graph/agentic_process/{proc['id']}/execute", json={"instruction": instruction})
    return _turn(c, proc["id"])


# ── the test ────────────────────────────────────────────────────────────────


def test_one_file_carries_every_asset_type_to_a_stranger_intact_and_alive(machines, tmp_path):
    a, b = machines
    tag = uuid.uuid4().hex[:6]
    words = _words()

    # A: the sender's project, indexed; then the agent names the MCP by its minted id.
    places = _seed(tmp_path / "sender", tag, words)
    _sh("docker", "cp", str(tmp_path / "sender"), f"{a['name']}:/root/")
    _project(a, SENDER)
    _index(a, SENDER)
    mcp_row = _rows(a, SENDER, {"mcp": places["mcp"]})["mcp"]
    _py(a, f'''
import json
from pathlib import Path
p = Path({SENDER!r}) / {places["agent"]!r} / "agent.json"
d = json.loads(p.read_text()); d["mcp_servers"] = [{mcp_row["typeid"]!r}]
p.write_text(json.dumps(d))
print("RESULT " + json.dumps(d["mcp_servers"]))
''')
    # Deliberately NOT re-indexed: A's agent row now lags its file (no MCP), the
    # way a hand-edited agent.json does. The export must ship what the FILE says.
    listed = _rows(a, SENDER, places)
    assert sorted(listed) == sorted(places), f"A did not index: {sorted(set(places) - set(listed))}"
    assert listed["agent"]["common"]["mcp_servers"] == [], "rig: A's agent row should lag its file here"

    r = httpx.post(f"{a['base']}/api/v1/graph/flow-message-export", timeout=120,
                   json={"text": f"everything, offline ({tag})", "asset_references": [s["typeid"] for s in listed.values()]})
    assert r.status_code == 200 and r.headers.get("content-type", "").startswith("application/zip"), r.text[:500]
    package = r.content
    # What A now holds — packing re-read the agent from its file.
    sent = _rows(a, SENDER, places)
    assert sent["agent"]["common"]["mcp_servers"] == [mcp_row["typeid"]], sent["agent"]["common"]

    # B: a stranger. Upload, see what was staged, install it all into an empty project.
    project_id = _project(b, RECEIVER)
    up = _api(b, "POST", "graph/flow-message-upload",
              files={"file": (f"offline-{tag}.flowmsg", package, "application/zip")})
    staged = {s["asset_type"]: s["asset_id"] for s in up["attachments"]}
    assert staged == {t: s["id"] for t, s in sent.items()}, f"staged {staged}"
    installed = _api(b, "POST", f"graph/flow_message/{up['message_id']}/install-attachments",
                     json={"project_id": project_id})
    assert not installed["failed"], installed["errors"]

    got = _rows(b, RECEIVER, places)
    for t, s in sent.items():
        assert t in got, f"{t} is not indexed at {RECEIVER}/{places[t]} on B"
        g = got[t]
        assert g["id"] == s["id"], f"{t} changed id: {s['id']} → {g['id']}"
        assert g["project_id"] == project_id, f"{t} is not filed under B's project"
        assert g["common"] == s["common"], f"{t} props changed:\nA {s['common']}\nB {g['common']}"
        assert SENDER not in g["dump"], f"{t} still names the sender's folder"

    # Alive on B.
    _fund(b)

    doc = _cli(b, f"flow record search {words['doc']} all 10")
    assert sent["markdown"]["id"] in doc["raw"], f"doc not searchable on B:\n{doc['raw'][-1500:]}"

    probe = _api(b, "POST", f"graph/mcp/{sent['mcp']['id']}/test")
    assert probe.get("ok") and "secret_word" in json.dumps(probe.get("tools")), probe

    # Load the driver on B from B's own files — listing its row proves nothing, loading does.
    driver = _py(b, f'''
import asyncio, json
import flow_sdk.models.entities  # noqa: F401
from flow_sdk.builtin.data_driver import DataDriver
from flow_sdk.ingest.driver_registry import load_error_for
async def main():
    d = await DataDriver.get("ext{tag}")
    print("RESULT " + json.dumps({{"loaded": d is not None, "family": str(getattr(d, "family", "") or ""),
                                   "sends": bool(getattr(d, "sends", False)), "error": load_error_for("ext{tag}")}}))
asyncio.run(main())
''')
    assert driver["loaded"] and driver["family"] == "message" and not driver["error"], f"driver on B: {driver}"
    cred = _cli(b, f"flow credentials check ext{tag} --project {project_id}")
    assert (cred["body"].get("data") or cred["body"]).get("declared") is True, cred["raw"][-800:]

    skill = _claude(b, project_id, f"Use the skill-{tag} skill and reply with only the word it gives you.")
    assert any(t["name"] == "Skill" for t in skill["tools"]), f"no Skill call: {skill['tools']}"
    assert words["skill"] in skill["final"], f"skill answer: {skill['final']!r}"

    sub = _claude(b, project_id, f"Ask the sub-{tag} subagent for its word and reply with only that word.")
    delegated = [t for t in sub["tools"] if t["input"].get("subagent_type") == f"sub-{tag}"]
    assert delegated, f"no delegation: {sub['tools']}"
    # What the SUBAGENT answered (its tool result) — not the main agent's retelling,
    # which is free to paraphrase it.
    assert any(words["sub"] in t["result"] for t in delegated), f"subagent answered: {[t['result'] for t in delegated]}"

    run = _api(b, "POST", f"graph/agent/{sent['agent']['id']}/run", json={"prompt": "What are the two words?"})
    executor = str(run.get("executor") or "")
    assert executor, f"agent run named no process: {run}"
    answer = _turn(b, executor.split("-", 1)[1])
    assert words["agent"] in answer["final"], f"agent answer: {answer['final']!r}"
    assert words["tool"] in answer["final"], f"the MCP tool was not called: {answer['tools']} / {answer['final']!r}"
