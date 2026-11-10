"""Runs INSIDE the container: start the backend, read the status record, assert.

    python check.py old       every CLI is old → each harness reports update=available
    python check.py slow      a 60s registry: startup is not held and nothing is shown
    python check.py offline   no network: no update, no error, backend healthy
    python check.py upgrade   after updating codex the warning clears
    python check.py too_old   real codex 400 "requires a newer version" → required
"""

import http.server
import json
import os
import subprocess
import sys
import threading
import time

PORT = int(os.environ["LOCAL_SERVER_PORT"])
STATUS = f"http://127.0.0.1:{PORT}/api/v1/graph/compute_node/@local/status"
CLIS = ["claude", "codex", "copilot", "opencode"]


def get(url, method="GET"):
    from flow_sdk.cli.commands._common import local_request  # carries the backend's local secret

    return local_request(method, url, json={} if method == "POST" else None, timeout=60).json()


def start_backend():
    t0 = time.time()
    proc = subprocess.Popen([sys.executable, "-m", "flow_sdk.server.run"],
                            stdout=open("/tmp/backend.log", "w"), stderr=subprocess.STDOUT)
    while time.time() - t0 < 120:
        try:
            get(f"http://127.0.0.1:{PORT}/health/status")
            return proc, time.time() - t0
        except Exception:
            time.sleep(0.5)
    print(open("/tmp/backend.log").read()[-3000:])
    raise SystemExit("backend never came up")


def harnesses():
    return {h["worker_type"]: h for h in get(STATUS)["data"]["harnesses"]}


def wait_for(pred, budget=90):
    t0 = time.time()
    while time.time() - t0 < budget:
        hs = harnesses()
        if pred(hs):
            return hs
        time.sleep(1)
    raise AssertionError(json.dumps({k: {f: v.get(f) for f in ("install", "version", "latest_version", "update")}
                                     for k, v in harnesses().items()}, indent=1))


def show(hs):
    for k in CLIS:
        h = hs[k]
        print(f"  {k:9} {h['version']:10} latest={h.get('latest_version') or '-':10} update={h.get('update')} "
              f"cmd={h.get('update_command', '')[:60]}")


def all_available(hs):
    return all(hs[k].get("update") == "available" for k in CLIS)


def stub(handler_body, delay=0.0, status=200):
    class H(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            self._reply()

        def do_POST(self):
            self.rfile.read(int(self.headers.get("Content-Length") or 0))
            self._reply()

        def _reply(self):
            time.sleep(delay)
            body = json.dumps(handler_body(self.path)).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *a):
            pass

        def handle(self):
            try:
                super().handle()
            except BrokenPipeError:  # the client gave up first — that is the point of the slow mode
                pass

    srv = http.server.ThreadingHTTPServer(("127.0.0.1", 0), H)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return f"http://127.0.0.1:{srv.server_port}"


def main(mode):
    if mode == "slow":
        os.environ["FLOW_NPM_REGISTRY"] = stub(lambda p: {"version": "99.0.0"}, delay=60)
    if mode == "too_old":
        return too_old()
    _, up = start_backend()
    print(f"backend healthy after {up:.1f}s")
    if mode == "old":
        show(wait_for(all_available))
    elif mode == "slow":
        assert up < 45, f"startup waited on the registry ({up:.1f}s)"
        time.sleep(10)  # past the 5s request cap: the check gave up, quietly
        hs = harnesses()
        show(hs)
        assert all(hs[k].get("update") == "none" for k in CLIS)
    elif mode == "offline":
        wait_for(lambda hs: all(hs[k]["install"] == "installed" for k in CLIS))
        time.sleep(10)  # give the check every chance to fail loudly
        hs = harnesses()
        show(hs)
        assert all(hs[k].get("update") == "none" for k in CLIS)
    elif mode == "upgrade":
        wait_for(all_available)
        subprocess.run(["npm", "install", "-g", "-q", "@openai/codex@latest"], check=True)
        get(STATUS + "/refresh", "POST")
        hs = wait_for(lambda hs: hs["codex"].get("update") == "none" and hs["claude"].get("update") == "available")
        show(hs)
    print(f"PASS {mode}")


def too_old():
    """Real codex against an API that refuses it the way Ami's did; its own error output is classified."""
    msg = "The 'gpt-6-astra' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again."
    base = stub(lambda p: {"error": {"message": msg, "type": "invalid_request_error"}}, status=400)
    env = {**os.environ, "OPENAI_API_KEY": "sk-test", "OPENAI_BASE_URL": f"{base}/v1", "CODEX_HOME": "/tmp/codex-home"}
    os.makedirs("/tmp/codex-home", exist_ok=True)
    provider = f'model_providers.stub={{name="stub",base_url="{base}/v1",env_key="OPENAI_API_KEY",wire_api="responses"}}'
    out = subprocess.run(["codex", "exec", "--json", "--skip-git-repo-check", "-m", "gpt-6-astra",
                          "-c", "model_provider=stub", "-c", provider, "hi"],
                         env=env, capture_output=True, text=True, timeout=120, cwd="/tmp")
    with open("/tmp/codex.jsonl", "w") as f:
        f.write(out.stdout)
    print(out.stdout[-1500:])
    import flow_sdk.core.status as st
    from flow_sdk.builtin.agentic_process.cli_drivers.codex.status import codex_tail_status
    from flow_sdk.core.capabilities import latest_version as lv

    st.publish_status_changed = lambda: None
    print("tail status:", codex_tail_status("/tmp/codex.jsonl"))
    state = lv.update_state("harness.codex.cli", "0.147.0")
    print("update state:", state)
    assert state[1] == "required", "codex's own too-old error was not recognised"
    print("PASS too_old")


if __name__ == "__main__":
    main(sys.argv[1])
