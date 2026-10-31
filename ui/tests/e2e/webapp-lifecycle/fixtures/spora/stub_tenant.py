"""Tier 2's stand-in for Spora's local tenant (chat-service on :8300): GET /api/bootstrap answers the public
bootstrap shape the app reads (platform/tenant/spec.py public()), CORS open.

`python3 stub_tenant.py <port> --detach` starts it in a session of its own and returns once it answers — what the
tier-2 copy of the `spora-tenant-launch` op runs in place of launching the real tenant through Admin."""
import http.server
import json
import subprocess
import sys
import time
import urllib.request

BODY = json.dumps({
    "schema": 1,
    "tenant": "local",
    "connect": {"project": "stub", "oauth_web_client_id": "", "api": ""},
    "runtime": {"project": "stub", "database": "cloudtest", "web": ""},
    "services": {}, "emulators": {},
}).encode()


class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        ok = self.path.split("?")[0] == "/api/bootstrap"
        self.send_response(200 if ok else 404)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(BODY if ok else b"{}")

    def log_message(self, *_):
        pass


def answers(port: int) -> bool:
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/bootstrap", timeout=1) as r:
            return r.status == 200
    except OSError:
        return False


if __name__ == "__main__":
    port = int(sys.argv[1])
    if "--detach" in sys.argv:
        subprocess.Popen([sys.executable, __file__, str(port)], start_new_session=True,
                         stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, stdin=subprocess.DEVNULL)
        while not answers(port):
            time.sleep(0.1)
        sys.exit(0)
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
