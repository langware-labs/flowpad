"""Receive captured DOM from a browser page and write it into a folder.

Usage: python -I capture_recv.py <out-dir> [port]
Binds 127.0.0.1 on <port>, or on a free port the OS picks when none is given, and prints
"PORT <n>" first. The page POSTs to http://127.0.0.1:<n>/<name>; the body is written to
<out-dir>/<name>. Stop it by its PID when the capture is done.
"""

import http.server
import os
import sys

OUT = sys.argv[1]
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 0


class Handler(http.server.BaseHTTPRequestHandler):
    def do_OPTIONS(self):  # noqa: N802 — a preflight from a page that sets headers
        self._ok()

    def do_POST(self):  # noqa: N802
        body = self.rfile.read(int(self.headers.get("Content-Length") or 0))
        name = os.path.basename(self.path.strip("/")) or "capture.html"
        with open(os.path.join(OUT, name), "wb") as fh:
            fh.write(body)
        self._ok()

    def _ok(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "*")
        self.end_headers()

    def log_message(self, *args):
        pass


os.makedirs(OUT, exist_ok=True)
server = http.server.HTTPServer(("127.0.0.1", PORT), Handler)
print(f"PORT {server.server_address[1]}", flush=True)
server.serve_forever()
