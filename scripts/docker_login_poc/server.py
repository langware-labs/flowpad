#!/usr/bin/env python3
"""Docker harness-login POC — one page, three auth buttons.

Generic flow (same for every harness):
  1. GET / serves a page with an Auth button per harness (claude/codex/copilot).
  2. Auth spawns the vendor's login command INSIDE the docker container under a
     host-side PTY, scrapes the OAuth URL (+ one-time code when the vendor uses
     a device flow) out of the stream, and shows them on the page.
  3. The user clicks the link and authorizes. Device flows (codex/copilot)
     complete on their own — the CLI polls. Claude in a container can't receive
     the localhost callback, so the browser shows a code; the page grows a
     paste box and we inject the pasted code into the login PTY.
  4. On completion the worker card flips to "authenticated" and exposes Test:
     a pure auth check (the same stdlib auth_probe.py the backend uses, exec'd
     in-container by file path) or a one-shot `-p` prompt whose output is
     shown for eyeball validation.

Stdlib only. Run:  python3 scripts/docker_login_poc/server.py  → http://localhost:8765
The container ({CONTAINER}) and its image are created on first use and left
running so credentials persist between auths and tests; remove with
`docker rm -f flowpad-login-poc` when done.
"""

from __future__ import annotations

import fcntl
import json
import os
import pty
import re
import select
import struct
import subprocess
import termios
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

PORT = 8765
IMAGE = "flowpad-login-poc"
CONTAINER = "flowpad-login-poc"
REPO_ROOT = Path(__file__).resolve().parents[2]
AUTH_PROBE_SRC = REPO_ROOT / "flow_sdk/builtin/agentic_process/cli_drivers/auth_probe.py"

ANSI_RE = re.compile(r"\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|[\r\x08]")
# OSC 8 terminal hyperlink: \x1b]8;;<target>\x07 — claude prints its OAuth URL
# as the TARGET (the visible text is a wrapped rendering), so lift targets out
# BEFORE generic OSC stripping deletes them.
OSC8_RE = re.compile(r"\x1b\]8;;([^\x07\x1b]+)(?:\x07|\x1b\\)")

WORKERS = {
    "claude": {
        "icon": "✳️",
        "login_cmd": ["claude", "auth", "login"],
        "url_re": re.compile(r"(https://(?:\S*\.)?(?:claude\.(?:ai|com)|anthropic\.com)/\S*oauth\S+)"),
        "code_re": None,  # claude shows the code in the BROWSER; user pastes it back
        "accepts_paste": True,
        "prompt_cmd": lambda p: ["claude", "-p", p],
    },
    "codex": {
        "icon": "◎",
        "login_cmd": ["codex", "login", "--device-auth"],
        "url_re": re.compile(r"(https://auth\.openai\.com/\S+)"),
        "code_re": re.compile(r"^\s*([A-Z0-9]{2,10}-[A-Z0-9]{2,10})\s*$", re.M),
        "accepts_paste": False,
        "prompt_cmd": lambda p: ["codex", "exec", "--skip-git-repo-check", p],
    },
    "copilot": {
        "icon": "\U0001f419",
        "login_cmd": ["copilot", "login"],
        "url_re": re.compile(r"(https://github\.com/login/device)"),
        "code_re": re.compile(r"enter (?:the )?code ([A-Z0-9]{4}-[A-Z0-9]{4})"),
        "accepts_paste": False,
        "prompt_cmd": lambda p: ["copilot", "-p", p, "--allow-all-tools"],
    },
}

# Interactive questions a login CLI may ask mid-flow (invisible to the page) —
# auto-answer them. Containers have no OS keychain, so plaintext storage is the
# only option and saying yes is what the user would do.
AUTO_ANSWERS = [
    (re.compile(r"Store token in plaintext config file\? \(y/N\)"), "y\r"),
]

# In-container pure auth check: exec the SAME auth_probe.py the backend ships,
# loaded by file path (it is deliberately stdlib-pure for exactly this).
AUTH_CHECK_SNIPPET = """
import importlib.util, json, os, shutil, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location("auth_probe", "/opt/auth_probe.py")
ap = importlib.util.module_from_spec(spec); sys.modules["auth_probe"] = ap
spec.loader.exec_module(ap)
w = sys.argv[1]
print(json.dumps(ap.probe_worker_auth(w, shutil.which(w), dict(os.environ), Path.home()).to_json()))
"""


def sh(argv: list[str], timeout: float = 300) -> subprocess.CompletedProcess:
    return subprocess.run(argv, capture_output=True, text=True, timeout=timeout)


def ensure_container() -> str | None:
    """Build image / start container if needed. Returns an error string or None."""
    if sh(["docker", "info"]).returncode != 0:
        return "docker daemon not available"
    if not sh(["docker", "image", "inspect", IMAGE]).returncode == 0:
        build = sh(["docker", "build", "-t", IMAGE, str(Path(__file__).parent)], timeout=600)
        if build.returncode != 0:
            return f"image build failed: {build.stderr[-400:]}"
    state = sh(["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER])
    if state.returncode != 0 or state.stdout.strip() != "true":
        sh(["docker", "rm", "-f", CONTAINER])
        run = sh([
            "docker", "run", "-d", "--name", CONTAINER,
            "-v", f"{AUTH_PROBE_SRC}:/opt/auth_probe.py:ro",
            "-e", "TERM=xterm-256color",
            IMAGE, "sleep", "infinity",
        ])
        if run.returncode != 0:
            return f"container start failed: {run.stderr[-400:]}"
    return None


class LoginSession:
    """One in-container login process under a host-side PTY."""

    def __init__(self, worker: str) -> None:
        self.worker = worker
        self.state = "starting"  # starting | awaiting_user | authenticated | error
        self.url: str | None = None
        self.code: str | None = None
        self.message = ""
        self.raw = ""
        self.buf = ""
        self._answered: set[int] = set()
        self.master_fd: int | None = None
        self.proc: subprocess.Popen | None = None
        threading.Thread(target=self._run, daemon=True).start()

    def _run(self) -> None:
        spec = WORKERS[self.worker]
        # Device may already be approved from an earlier flow (or creds still
        # on disk) — probe first and skip the login entirely when logged in.
        pre = run_auth_check(self.worker)
        if pre.get("status") == "logged_in":
            self.state = "authenticated"
            self.message = "already authenticated — " + pre.get("message", "")
            return
        master, slave = pty.openpty()
        # Very wide terminal so long OAuth URLs never soft-wrap (a wrapped URL
        # can't be regexed back together safely). docker exec -t mirrors the
        # client TTY size into the container.
        fcntl.ioctl(slave, termios.TIOCSWINSZ, struct.pack("HHHH", 50, 1000, 0, 0))
        self.master_fd = master
        self.proc = subprocess.Popen(
            ["docker", "exec", "-it", CONTAINER, *spec["login_cmd"]],
            stdin=slave, stdout=slave, stderr=slave, close_fds=True,
        )
        os.close(slave)
        while True:
            if self.proc.poll() is not None:
                break
            r, _, _ = select.select([master], [], [], 0.5)
            if not r:
                continue
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            # Reprocess the whole raw stream each read: escape sequences can
            # split across chunk boundaries, so incremental stripping corrupts.
            self.raw += chunk.decode("utf-8", "replace")
            self.buf = ANSI_RE.sub("", OSC8_RE.sub(r" \1 ", self.raw))
            self._scrape(spec)
            for i, (pattern, answer) in enumerate(AUTO_ANSWERS):
                if i not in self._answered and pattern.search(self.buf):
                    self._answered.add(i)
                    os.write(master, answer.encode())
        rc = self.proc.wait()
        # The login process exiting is not proof of success — always re-check
        # with the pure probe before declaring the worker authenticated.
        result = run_auth_check(self.worker)
        if result.get("status") == "logged_in":
            self.state = "authenticated"
            self.message = result.get("message", "")
        elif self.state != "error":
            self.state = "error"
            self.message = f"login exited rc={rc}; probe says {result.get('status')}: " + self.buf.strip()[-300:]

    def _scrape(self, spec: dict) -> None:
        if self.url is None:
            # CLIs hard-wrap long OAuth URLs; rejoin a wrapped URL by gluing
            # subsequent lines that consist purely of URL characters.
            unwrapped = re.sub(r"(https://\S+)((?:\n[A-Za-z0-9%&=+_.~/:?\-]+)+)",
                               lambda m: m.group(1) + m.group(2).replace("\n", ""),
                               self.buf)
            m = spec["url_re"].search(unwrapped)
            if m:
                self.url = m.group(1).rstrip(".,)")
        if self.code is None and spec["code_re"] is not None:
            m = spec["code_re"].search(self.buf)
            if m:
                self.code = m.group(1)
        if self.url and self.state == "starting":
            self.state = "awaiting_user"

    def paste_code(self, code: str) -> None:
        if self.master_fd is not None and self.proc and self.proc.poll() is None:
            os.write(self.master_fd, (code.strip() + "\r").encode())

    def cancel(self) -> None:
        if self.proc and self.proc.poll() is None:
            self.proc.kill()

    def to_json(self) -> dict:
        return {
            "state": self.state, "url": self.url, "code": self.code,
            "message": self.message, "tail": self.buf.strip()[-400:],
        }


SESSIONS: dict[str, LoginSession] = {}
LOCK = threading.Lock()


_IDLE_CACHE: dict[str, dict] = {}


def idle_status(worker: str) -> dict:
    """State for a worker with no login in flight: authenticated when the
    container already holds credentials (e.g. after a server restart)."""
    if sh(["docker", "inspect", "-f", "{{.State.Running}}", CONTAINER]).stdout.strip() != "true":
        return {"state": "idle"}
    if worker not in _IDLE_CACHE:
        result = run_auth_check(worker)
        _IDLE_CACHE[worker] = (
            {"state": "authenticated", "message": "already authenticated — " + result.get("message", "")}
            if result.get("status") == "logged_in" else {"state": "idle"}
        )
    return _IDLE_CACHE[worker]


def run_auth_check(worker: str) -> dict:
    proc = sh(["docker", "exec", CONTAINER, "python3", "-c", AUTH_CHECK_SNIPPET, worker], timeout=30)
    try:
        return json.loads(proc.stdout.strip().splitlines()[-1])
    except Exception:
        return {"status": "unknown", "message": (proc.stderr or proc.stdout)[-300:]}


def run_prompt(worker: str, prompt_text: str) -> dict:
    argv = WORKERS[worker]["prompt_cmd"](prompt_text)
    try:
        proc = sh(["docker", "exec", CONTAINER, *argv], timeout=120)
    except subprocess.TimeoutExpired:
        return {"ok": False, "output": "(prompt timed out)"}
    out = (proc.stdout or "").strip() or (proc.stderr or "").strip()
    return {"ok": proc.returncode == 0, "output": out[-1500:]}


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *a):  # quiet
        pass

    def _json(self, obj, status=200):
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _read_body(self) -> dict:
        n = int(self.headers.get("Content-Length") or 0)
        return json.loads(self.rfile.read(n) or b"{}")

    def do_GET(self):
        if self.path == "/":
            body = (Path(__file__).parent / "page.html").read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        m = re.fullmatch(r"/api/status/(\w+)", self.path)
        if m and m.group(1) in WORKERS:
            s = SESSIONS.get(m.group(1))
            self._json(s.to_json() if s else idle_status(m.group(1)))
            return
        self._json({"error": "not found"}, 404)

    def do_POST(self):
        m = re.fullmatch(r"/api/(auth|code|cancel|test)/(\w+)", self.path)
        if not m or m.group(2) not in WORKERS:
            self._json({"error": "not found"}, 404)
            return
        action, worker = m.groups()
        if action == "auth":
            err = ensure_container()
            if err:
                self._json({"error": err}, 500)
                return
            with LOCK:
                _IDLE_CACHE.pop(worker, None)
                old = SESSIONS.get(worker)
                if old:
                    old.cancel()
                SESSIONS[worker] = LoginSession(worker)
            self._json({"ok": True})
        elif action == "code":
            s = SESSIONS.get(worker)
            if not s:
                self._json({"error": "no login in progress"}, 409)
                return
            s.paste_code(self._read_body().get("code", ""))
            self._json({"ok": True})
        elif action == "cancel":
            s = SESSIONS.pop(worker, None)
            if s:
                s.cancel()
            self._json({"ok": True})
        elif action == "test":
            body = self._read_body()
            if body.get("mode") == "prompt":
                self._json(run_prompt(worker, body.get("prompt") or "Reply with exactly: FLOWPAD-OK"))
            else:
                self._json(run_auth_check(worker))


if __name__ == "__main__":
    print(f"docker login POC → http://localhost:{PORT}  (container: {CONTAINER})")
    ThreadingHTTPServer(("127.0.0.1", PORT), Handler).serve_forever()
