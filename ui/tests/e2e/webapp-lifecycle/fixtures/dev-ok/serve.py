"""Stub dev server: serves ./public on 127.0.0.1:<port>; /health answers 200.

Injections: STUB_FAIL_HEALTH=1 (env) or a `.fail_health` file → /health is 404.
Refuses to start (exit 1) when the install marker is missing or not JSON.
"""
import http.server
import json
import os
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
MARKER = HERE / ".installed" / "marker.json"


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(HERE / "public"), **kw)

    def do_GET(self):
        if self.path.split("?")[0] == "/health":
            fail = os.environ.get("STUB_FAIL_HEALTH") == "1" or (HERE / ".fail_health").exists()
            self.send_response(404 if fail else 200)
            self.end_headers()
            self.wfile.write(b"no" if fail else b"ok")
            return
        super().do_GET()

    def log_message(self, *_):
        pass


if __name__ == "__main__":
    try:
        json.loads(MARKER.read_text())
    except (OSError, ValueError):
        print(f"install marker missing or corrupt: {MARKER}", file=sys.stderr)
        sys.exit(1)
    http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
