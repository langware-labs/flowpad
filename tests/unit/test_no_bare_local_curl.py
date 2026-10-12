"""No shipped script or assistant instruction curls the local API without the gate token (FLOWPAD-2233).

The backend refuses every request that does not present its cookie-gate token. A `curl` to
`localhost`/`127.0.0.1` `/api/...` or `/health...` in a script or in the instructions an agent follows
therefore has to send `X-Cookie-Gate` (read from the instance's `.cookie_gate`), or it reports a
healthy backend as broken. Prefer the `flow` CLI where one exists: it sends the token itself.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]
SCANNED = [
    (REPO / "scripts", ("*.sh",)),
    (REPO / "flow_sdk" / "system_projects", ("*.md", "*.sh")),
]
# Dev rigs that only ever talk to instances launched with FLOWPAD_COOKIE_GATE=off (instance_ctl).
DEV_ONLY = {
    "scripts/instance_ctl.sh",
    "scripts/qa_phase11_sweep.sh",
    "scripts/verify_instance_reset.sh",
    "scripts/e2e_flow_connect_docker.sh",
}
LOCAL_API = re.compile(r"https?://(?:localhost|127\.0\.0\.1)[^\s\"'`]*?/(?:api/|health)")
SENDS_TOKEN = re.compile(r"X-Cookie-Gate|\$\(gate\)|\$GATE|\"\$GATE\"", re.IGNORECASE)


def _commands(text: str):
    """Logical lines: shell continuations (`\\` at end of line) joined."""
    buf = ""
    for line in text.splitlines():
        if line.rstrip().endswith("\\"):
            buf += line.rstrip()[:-1] + " "
            continue
        yield buf + line
        buf = ""
    if buf:
        yield buf


def _offenders():
    for root, patterns in SCANNED:
        for pattern in patterns:
            for path in root.rglob(pattern):
                rel = path.relative_to(REPO).as_posix()
                if rel in DEV_ONLY or "node_modules" in rel:
                    continue
                text = path.read_text(encoding="utf-8", errors="replace")
                if "FLOWPAD_COOKIE_GATE=off" in text:
                    continue
                for command in _commands(text):
                    if "curl" in command and LOCAL_API.search(command) and not SENDS_TOKEN.search(command):
                        yield f"{rel}: {command.strip()[:160]}"


def test_no_local_api_curl_without_the_gate_token():
    offenders = list(_offenders())
    assert offenders == [], "local API curl without X-Cookie-Gate:\n" + "\n".join(offenders)
