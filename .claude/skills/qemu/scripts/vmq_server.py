#!/usr/bin/env python3
"""Job queue between the Mac and the Windows VM's vmagent pollers.

The guest reaches this at 10.0.2.2:8766 (VMQ_PORT) (QEMU user-net maps it to the host's 127.0.0.1).
Lanes: "user" (normal token, like a real user) and "admin" (elevated).
Use vmrun.py to submit a job and wait for its output.
"""
import json, os, threading, time, uuid
from collections import deque
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler
from urllib.parse import urlparse, parse_qs

PORT = int(os.environ.get("VMQ_PORT", 8766))
lock = threading.Condition()
queues = {"user": deque(), "admin": deque()}
results = {}
last_seen = {}


class H(BaseHTTPRequestHandler):
    def log_message(self, *a):
        pass

    def _send(self, code, obj=None):
        body = b"" if obj is None else json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _q(self):
        u = urlparse(self.path)
        return u.path, {k: v[0] for k, v in parse_qs(u.query).items()}

    def do_GET(self):
        path, q = self._q()
        if path == "/next":
            lane = q.get("lane", "user")
            with lock:
                last_seen[lane] = time.time()
                lock.wait_for(lambda: queues.setdefault(lane, deque()), timeout=20)
                job = queues[lane].popleft() if queues[lane] else None
            return self._send(200, job) if job else self._send(204)
        if path.startswith("/wait/"):
            jid = path.split("/")[2]
            with lock:
                lock.wait_for(lambda: jid in results, timeout=float(q.get("t", 30)))
                res = results.pop(jid, None)
            return self._send(200, res) if res else self._send(204)
        if path == "/status":
            now = time.time()
            return self._send(200, {l: round(now - t, 1) for l, t in last_seen.items()})
        self._send(404)

    def do_POST(self):
        path, q = self._q()
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if path == "/submit":
            job = {"id": uuid.uuid4().hex[:12], "cmd": body.decode(), "timeout": int(q.get("timeout", 600))}
            with lock:
                queues.setdefault(q.get("lane", "user"), deque()).append(job)
                lock.notify_all()
            return self._send(200, {"id": job["id"]})
        if path.startswith("/result/"):
            with lock:
                results[path.split("/")[2]] = json.loads(body.decode("utf-8-sig"))
                lock.notify_all()
            return self._send(200, {})
        self._send(404)


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
