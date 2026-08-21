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

TITLE = "ניהול משימות"
BODY = "אין משימות"  # leading alef is UTF-8 D7 90 — the byte cp1252 leaves undefined

# Enters exactly where MicroApp.view enters it (micro_app.py:164) — same args,
# same Request, one frame down from the route.
DRIVER = r"""
import asyncio, locale, re, sys
from pathlib import Path
from starlette.requests import Request
from flow_sdk.builtin.faas.serve_static import serve_app_bytes

root = Path(sys.argv[1])
scope = {
    "type": "http", "http_version": "1.1", "method": "GET", "scheme": "http",
    "path": "/api/v1/graph/micro_app/app-1/view", "raw_path": b"/", "query_string": b"",
    "root_path": "", "headers": [(b"host", b"localhost:8000")],
    "server": ("localhost", 8000), "client": ("127.0.0.1", 1234),
}

async def main():
    resp = await serve_app_bytes(root, None, Request(scope), api_url_scheme="http")
    body = resp.body.decode("utf-8")
    # Expectations are derived HERE, from the file, with an explicit encoding.
    # Nothing non-ASCII may cross into this process any other way: argv is
    # decoded with the filesystem encoding, which under this test's whole
    # premise (a non-UTF-8 ambient) is ASCII+surrogateescape on POSIX. Passing
    # the needle in would fail the comparison for the wrong reason -- it did,
    # on ubuntu CI, while the server had served the page perfectly.
    src = (root / "index.html").read_text(encoding="utf-8")
    needles = re.findall(r"<title>(.*?)</title>", src) + re.findall(r"<h1>(.*?)</h1>", src)
    print("AMBIENT:" + locale.getpreferredencoding(False))
    print("STATUS:%d" % resp.status_code)
    print("NONASCII:%s" % any(ord(c) > 127 for n in needles for c in n))
    print("INTACT:%s" % (bool(needles) and all(n in body for n in needles)))

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
        [sys.executable, "-c", DRIVER, str(app_root)],
        cwd=REPO_ROOT,
        env=_child_env(),
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )


# flowpad:capsule tag
# version: 1
# data:
#   tags:
#     breadcrumb.test.served_html_encoding.rules: FAILING? read this tag's rules before
#       editing — a UTF-8 CI cannot see this bug, do not relax the assertion
# flowpad:endcapsule tag
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
    # Guards against the test quietly becoming vacuous if the fixture ever loses
    # its non-ASCII content: with nothing to mangle, INTACT is True for free.
    assert "NONASCII:True" in result.stdout, result.stdout
    assert "INTACT:True" in result.stdout, (
        "served document was silently mangled (decoded with the host codepage):\n" + result.stdout
    )
