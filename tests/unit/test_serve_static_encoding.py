"""``serve_app_bytes`` must not inherit the host's text encoding.

The api-tier twin of this test (``test_non_ascii_index_is_served_intact``) only
bites on a host whose locale codepage is not UTF-8 — a Windows laptop. CI is
ubuntu-latest with a UTF-8 locale, where it passes whether or not the defect is
present. That makes it a witness, not a guard.

This one supplies the missing half: it runs the real ``serve_app_bytes`` in a
real child process whose *ambient* encoding is genuinely not UTF-8, which is the
whole of the bug's precondition. Nothing is mocked or patched — the child is an
ordinary interpreter, told via the environment what every Windows interpreter is
told by its codepage.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]

# Passed to the child as argv, never embedded in its source: the driver stays pure
# ASCII so the child's own source decoding can't become a second variable here.
TITLE = "ניהול משימות"
BODY = "אין משימות"  # leading alef is UTF-8 D7 90 — the byte cp1252 leaves undefined

# Enters exactly where MicroApp.view enters it (micro_app.py:164) — same args,
# same Request, one frame down from the route.
DRIVER = r"""
import asyncio, locale, sys
from pathlib import Path
from starlette.requests import Request
from flow_sdk.builtin.faas.serve_static import serve_app_bytes

root, needle = Path(sys.argv[1]), sys.argv[2]
scope = {
    "type": "http", "http_version": "1.1", "method": "GET", "scheme": "http",
    "path": "/api/v1/graph/micro_app/app-1/view", "raw_path": b"/", "query_string": b"",
    "root_path": "", "headers": [(b"host", b"localhost:8000")],
    "server": ("localhost", 8000), "client": ("127.0.0.1", 1234),
}

async def main():
    resp = await serve_app_bytes(root, None, Request(scope), api_url_scheme="http")
    body = resp.body.decode("utf-8")
    print("AMBIENT:" + locale.getpreferredencoding(False))
    print("STATUS:%d" % resp.status_code)
    print("INTACT:%s" % (needle in body))

asyncio.run(main())
"""


def _child_env() -> dict[str, str]:
    """An interpreter whose default text encoding is NOT UTF-8 — for real."""
    env = dict(os.environ)
    env["PYTHONUTF8"] = "0"  # do not opt into UTF-8 mode
    env["PYTHONCOERCECLOCALE"] = "0"  # do not let CPython upgrade a C locale for us
    env["PYTHONIOENCODING"] = "utf-8"  # stdout only; does not touch open()'s default
    if os.name != "nt":
        env["LC_ALL"] = env["LANG"] = "C"  # POSIX: ASCII default, same defect class
    return env


def _run(app_root: Path) -> subprocess.CompletedProcess:
    return subprocess.run(
        [sys.executable, "-c", DRIVER, str(app_root), BODY],
        cwd=REPO_ROOT,
        env=_child_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )


def test_utf8_app_survives_a_non_utf8_host(tmp_path):
    dist = tmp_path / "tasks-app" / "dist"
    dist.mkdir(parents=True)
    (dist / "index.html").write_text(
        f'<html lang="he" dir="rtl"><head><meta charset="utf-8" />'
        f"<title>{TITLE}</title></head><body><h1>{BODY}</h1></body></html>",
        encoding="utf-8",
    )

    result = _run(dist)

    ambient = next(
        (ln.split(":", 1)[1] for ln in result.stdout.splitlines() if ln.startswith("AMBIENT:")),
        None,
    )
    if ambient and "utf" in ambient.lower().replace("-", ""):
        pytest.skip(f"host would not yield a non-UTF-8 default encoding (got {ambient}); nothing to prove here")

    assert result.returncode == 0, (
        "serving a UTF-8 app died on a non-UTF-8 host:\n" + result.stderr[-2000:]
    )
    assert "STATUS:200" in result.stdout, result.stdout
    assert "INTACT:True" in result.stdout, (
        "served document was silently mangled (decoded with the host codepage):\n" + result.stdout
    )
