"""An external connector, handed over as a .flowmsg, installed on a plain e2b box and set up there (WAHA).

Proven 2026-09-28: the WAHA connector exported from the local `waha` project (`flow-message-export`),
on a box of a template built from this branch (`ops/e2b/flowpad-exec-env/build.sh --local`), its hub
local and reachable from the box through ngrok. Host side; run from the hub checkout with its venv
(it has the e2b SDK and the hub's E2B key), the hub's env stripped of the desk's:

    cd ../test_flowpad/FlowPad && env -u DEPLOY_ENV -u SOD_ENC_KEY PYTHONPATH=. \
        FLOWMSG=<the .flowmsg> HUB=http://localhost:8093 EMAIL=<hub user> PASSWORD=... [NODE=<compute_node id>] \
        .venv/bin/python <flowpad-oss>/tests/e2e/connector_on_e2b.py

Leaves the box running (NODE= reuses it); delete the compute_node through the hub when done.

1. as a hub user: a workspace compute node, `ops/setup`, `ops/workspace-ready` (a plain box, nothing on it)
2. into the box: the .flowmsg + the rig (channel_doubles.py, source_setup_wizard.py)
3. in the box: a project, upload the file, install-all into it, an agent, a WAHA source it owns
4. in the box: the WAHA Double (found through the backend: the installed connector's own tests/matrix.py)
5. in the box: the WAHA setup wizard, headless — asks answered, the Double's /pair standing in for the QR
"""
from __future__ import annotations

import json
import os
import shlex
import sys
import time
from pathlib import Path

import httpx

OSS = Path(__file__).resolve().parents[2]
HUB = os.environ.get("HUB", "http://localhost:8093").rstrip("/")
FLOWMSG = Path(os.environ["FLOWMSG"])
RIG = ["tests/__init__.py", "tests/unit/__init__.py", "tests/unit/_stream_inbox_matrix.py",
       "tests/e2e/channel_doubles.py", "tests/e2e/source_setup_wizard.py"]


def log(*a):
    print(*a, flush=True)


def hub() -> httpx.Client:
    r = httpx.post(f"{HUB}/api/v1/login", json={"email": os.environ["EMAIL"], "password": os.environ["PASSWORD"]},
                   headers={"Origin": HUB}, timeout=30)
    token = r.json()["data"]["token"]
    return httpx.Client(base_url=f"{HUB}/api/v1", headers={"Authorization": f"Bearer {token}", "Origin": HUB}, timeout=900)


def ok(r: httpx.Response) -> dict:
    body = r.json()
    if r.status_code >= 400 or body.get("status") not in (None, "SUCCESS"):
        raise SystemExit(f"{r.request.method} {r.request.url} → {r.status_code}: {json.dumps(body)[:1500]}")
    return body.get("data") if isinstance(body, dict) and "data" in body else body


def box(client: httpx.Client) -> dict:
    node_id = os.environ.get("NODE")
    if not node_id:
        node = ok(client.post("graph/compute_node", json={
            "type": "compute_node", "name": f"waha-e2b-{int(time.time())}", "node_provider": "e2b", "node_config": {"flavor": "workspace"},
        }))
        node_id = node["id"]
        log("node", node_id)
        t = time.monotonic()
        log("setup", json.dumps(ok(client.post(f"graph/compute_node/{node_id}/ops/setup", json={})))[:300], f"{time.monotonic()-t:.0f}s")
    t = time.monotonic()
    ready = ok(client.post(f"graph/compute_node/{node_id}/ops/workspace-ready", json={}))
    log("workspace-ready", json.dumps(ready)[:400], f"{time.monotonic()-t:.0f}s")
    return ok(client.get(f"graph/compute_node/{node_id}"))


def main() -> int:
    if not os.environ.get("E2B_API_KEY"):
        from flowpad.config import default_service_config  # the hub's own key: the box is on its team

        os.environ["E2B_API_KEY"] = default_service_config.e2b_api_key or ""
    from e2b import Sandbox

    client = hub()
    node = box(client)
    sandbox_id = node.get("node_provider_id")
    log("sandbox", sandbox_id)
    sbx = Sandbox.connect(sandbox_id)

    def sh(cmd: str, *, timeout: float = 300, check: bool = True) -> str:
        res = sbx.commands.run(cmd, timeout=timeout)
        if check and res.exit_code:
            raise SystemExit(f"box: {cmd}\n{res.stdout[-2000:]}\n{res.stderr[-2000:]}")
        return res.stdout

    home = sh("echo $HOME").strip()
    server = json.loads(sh("cat ~/.flow/instances/*/server.json | head -c 2000"))
    instance = sh("ls ~/.flow/instances | head -1").strip()
    port = server.get("port")
    base = f"http://127.0.0.1:{port}"
    flow = sh("command -v flow").strip()
    py = sh(f"head -1 {shlex.quote(flow)}").strip().lstrip("#!").strip() or "python3"
    log("box app", base, "instance", instance, "version", sh(f"{py} -c 'import flow_sdk._version as v;print(v.__version__)'").strip())

    gate = json.loads(sh(f"{py} -c 'import json,sys;from flow_sdk.instance_settings.cookie_gate import gate_headers as g;print(json.dumps(g(sys.argv[1])))' {base}").strip() or "{}")
    hdr = " ".join(f"-H {shlex.quote(f'{k}: {v}')}" for k, v in gate.items())
    log("gate", "armed" if gate else "none")

    rig = f"{home}/rig"
    for rel in RIG:
        sbx.files.write(f"{rig}/{rel}", (OSS / rel).read_text(encoding="utf-8"))
    sbx.files.write(f"{home}/waha-connector.flowmsg", FLOWMSG.read_bytes())

    def api(method: str, route: str, body: dict | None = None) -> dict:
        data = f"-d {shlex.quote(json.dumps(body))}" if body is not None else ""
        out = sh(f"curl -s -X {method} {base}/api/v1/{route} {hdr} -H 'Content-Type: application/json' {data}")
        parsed = json.loads(out)
        if parsed.get("status") != "SUCCESS":
            raise SystemExit(f"box {method} {route}: {out[:1500]}")
        return parsed.get("data")

    project_dir = f"{home}/waha-rx"
    sh(f"mkdir -p {project_dir}")
    project = api("POST", "graph/project", {"type": "project", "name": "waha-rx", "fs_storage_mount_path": project_dir})
    log("project", project["id"])
    up = json.loads(sh(f"curl -s -X POST '{base}/api/v1/graph/flow-message-upload?overwrite=true' {hdr} -F file=@{home}/waha-connector.flowmsg"))
    staged = up["data"]["attachments"]
    log("staged", [(a["asset_type"], a["name"], a["asset_id"]) for a in staged])
    installed = api("POST", f"graph/flow_message/{up['data']['message_id']}/install-attachments", {"project_id": project["id"]})
    log("installed", installed)
    if installed["failed"]:
        return 1
    log("files", sh(f"cd {project_dir} && find agentic-assets -type f | sort | head -40"))

    run_tag = f"{int(time.time()) % 100000}"
    agent = api("POST", f"graph/project/{project['id']}/agent",
                {"type": "agent", "name": f"wa-bot-{run_tag}", "description": "Answers on WhatsApp", "worker_type": "claude"})
    source = api("POST", f"graph/project/{project['id']}/data_source",
                 {"provider": "waha", "name": f"WAHA wa-bot {run_tag}", "config": {"session": "default"}, "owner": f"agent-{agent['id']}"})
    log("agent", agent["id"], "source", source["id"])
    log("stages", api("GET", f"graph/data_source/{source['id']}/setup_stages"))

    # The Double is the connector's own test double: its module imports pytest, which a plain box lacks.
    sh(f"{py} -c 'import pytest' 2>/dev/null || {py} -m pip install -q pytest", timeout=300)
    env = f"FLOW_INSTANCE={instance}"
    sbx.commands.run(f"cd {rig} && {env} nohup {py} tests/e2e/channel_doubles.py --backend {base} --channels waha --own-credentials > {rig}/doubles.log 2>&1 &",
                     background=True)
    control = ""
    for _ in range(60):
        text = sh(f"cat {rig}/doubles.log 2>/dev/null || true", check=False)
        if '"control"' in text:
            control = json.loads(next(line for line in text.splitlines() if '"control"' in line))["control"]
            break
        time.sleep(1)
    if not control:
        log("doubles did not start:\n", sh(f"tail -40 {rig}/doubles.log", check=False))
        return 1
    creds = json.loads(sh(f"curl -s {control}/channels"))["waha"]["credential"]["values"]
    answers = {"waha-ask-base-url": creds["WAHA_BASE_URL"], "waha-ask-api-key": creds["WAHA_API_KEY"], "waha-ask-pair": "ok"}
    run = sh(
        f"cd {rig} && {env} {py} tests/e2e/source_setup_wizard.py --backend {base} --source {source['id']} "
        f"--answers {shlex.quote(json.dumps(answers))} --before {shlex.quote(f'waha-ask-pair={control}/pair ' + json.dumps({'channel': 'waha'}))} --timeout 300",
        timeout=420, check=False,
    )
    result = json.loads(run.strip().splitlines()[-1])
    log("wizard done", result["done"], "answered", result["answered"], "source", result["source"])
    for name, step in (result["result"].get("steps") or {}).items():
        log("  ", name, step.get("exit_code"), (step.get("detail") or "")[:200])
    return 0 if result["done"] else 1


if __name__ == "__main__":
    sys.exit(main())
