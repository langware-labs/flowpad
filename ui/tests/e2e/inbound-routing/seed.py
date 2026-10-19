"""Seed the inbound-routing E2E on a disposable instance: a project of its own with three agents (A, B, C), each
deployed locally and owning one WhatsApp channel on the waha stack's number (``waha_stack.py``). The channels are
RECEIVERS only — no hub claim is made for them here; the routing is configured in the Inbound UI by the spec.
A group channel (C) is that number's group. Prints the ids as JSON; ``--cleanup <json>`` removes them.

    FLOW_INSTANCE=inbound-1 uv run python ui/tests/e2e/inbound-routing/seed.py --backend http://localhost:6007 \\
        --control http://127.0.0.1:7391 > /tmp/inbound-seed.json
"""

import argparse
import asyncio
import json
import shutil
import sys
import tempfile
import uuid
from pathlib import Path

import httpx

PREFIX = "inbound-e2e-"
PROMPT = ("You are test agent {name}. Whatever anyone writes, answer with exactly one line: "
          "AGENT-{name}: <their message, word for word>. Nothing else, no tools.")


async def graph(api: httpx.AsyncClient, method: str, path: str, **kw):
    r = await api.request(method, f"/graph/{path}", **kw)
    body = r.json()
    if r.status_code >= 400 or body.get("status") == "FAIL":
        raise RuntimeError(f"{method} {path}: {r.status_code} {body.get('message') or body}")
    return body.get("data")


async def seed(backend: str, control: str, group: str) -> dict:
    api = httpx.AsyncClient(base_url=backend.rstrip("/") + "/api/v1", timeout=120)
    cfg = (await httpx.AsyncClient().get(f"{control}/ctl/config")).json()
    boot = await graph(api, "get", "bootstrap")
    user = boot.get("user") or {}
    project = await graph(api, "post", f"user/{user['id']}/project", json={"name": f"{PREFIX}{uuid.uuid4().hex[:6]}"})
    env = Path(tempfile.mkdtemp(prefix="inbound-e2e-")) / "whatsapp.env"
    env.write_text(f"FLOW_WHATSAPP_TOKEN={cfg['token']}\nFLOW_WHATSAPP_SECRET={cfg['app_secret']}\nFLOW_WHATSAPP_WEBHOOK_URL=\n")
    out = {"project_id": project["id"], "env_file": str(env), "agents": {}}
    for name in ("A", "B", "C"):
        agent = await graph(api, "post", f"project/{project['id']}/agent", json={
            "name": f"Inbound {name}", "worker_type": "claude", "system_prompt": PROMPT.format(name=name)})
        deployed = await graph(api, "post", f"agent/{agent['id']}/deploy", json={"provider": "local"})
        config = {"phone_number_id": cfg["phone_number_id"], "waba_id": cfg["waba_id"], "app_id": cfg["app_id"],
                  "base_url": cfg["base_url"], **({"group": group} if name == "C" and group else {})}
        source = await graph(api, "post", f"project/{project['id']}/data_source", json={
            "name": f"Inbound {name} WhatsApp", "provider": "whatsapp", "config": config,
            "owner": f"agent-{agent['id']}", "open_to_all": True, "status": "active",
            "secret_store": {"type": "env_file", "config": {"env_file_path": str(env)}}})
        row = await graph(api, "get", f"data_source/{source['id']}")
        out["agents"][name] = {"agent_id": agent["id"], "deployment_id": deployed["deployment"]["id"],
                               "source_id": source["id"], "status": row.get("status")}
    return out


async def cleanup(backend: str, seeded: dict) -> None:
    api = httpx.AsyncClient(base_url=backend.rstrip("/") + "/api/v1", timeout=120)
    for a in seeded["agents"].values():
        await api.post(f"/graph/deployment/{a['deployment_id']}/pause", json={})
        await api.delete(f"/graph/data_source/{a['source_id']}")
        await api.delete(f"/graph/agent/{a['agent_id']}")
    project = await graph(api, "get", f"project/{seeded['project_id']}")
    folder = Path(str(project.get("fs_storage_mount_path") or ""))
    await api.delete(f"/graph/project/{seeded['project_id']}")
    if folder.name.startswith(PREFIX) and folder.is_dir():
        shutil.rmtree(folder)


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--backend", required=True)
    p.add_argument("--control", default="")
    p.add_argument("--group", default="")
    p.add_argument("--cleanup", default="")
    a = p.parse_args()
    if a.cleanup:
        asyncio.run(cleanup(a.backend, json.loads(Path(a.cleanup).read_text())))
        return
    json.dump(asyncio.run(seed(a.backend, a.control, a.group)), sys.stdout, indent=2)


if __name__ == "__main__":
    main()
