"""Stub tenant service: GET /api/bootstrap → the public bootstrap shape, CORS open."""
import http.server
import json
import sys

BODY = json.dumps({"tenant": {"id": "stub", "name": "Stub tenant"}, "features": {}}).encode()


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


if __name__ == "__main__":
    http.server.ThreadingHTTPServer(("127.0.0.1", int(sys.argv[1])), Handler).serve_forever()
