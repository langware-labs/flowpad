"""A redirected stdout that is not UTF-8 cannot crash the flow CLI.

On Windows a stdout that is not a console gets the ANSI code page (cp1252), and
``flow connect`` died printing its own enrollment code — the banner's QR block
glyphs are outside cp1252 — whenever its output was piped or redirected. The CLI
entry now switches such streams to UTF-8 (``flow_sdk.cli.utf8_stdio``).

``PYTHONIOENCODING=cp1252`` on a piped stdout reproduces that exact stream on any
OS, so the real banner is printed by a real child process both ways.
"""

import os
import subprocess
import sys

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

_PRINT_BANNER = """
{setup}
from flow_sdk.cli.auth.device_enroll import enrollment_banner
print(enrollment_banner(
    "http://hub.test",
    user_code="ABCD-EFGH",
    verification_uri="http://hub.test/dock/hub/home",
    verification_uri_complete="http://hub.test/dock/hub/home?connect_code=ABCD-EFGH",
))
"""


def _print_banner_piped(setup: str) -> subprocess.CompletedProcess:
    env = {**os.environ, "PYTHONIOENCODING": "cp1252"}
    return subprocess.run(
        [sys.executable, "-c", _PRINT_BANNER.format(setup=setup)],
        capture_output=True,
        env=env,
        timeout=20,
    )


def test_the_enrollment_banner_crashes_a_cp1252_pipe_without_the_switch():
    result = _print_banner_piped(setup="")

    assert result.returncode != 0
    assert b"UnicodeEncodeError" in result.stderr


def test_the_cli_entry_makes_a_cp1252_pipe_print_the_banner():
    result = _print_banner_piped(setup="from flow_sdk.cli import utf8_stdio; utf8_stdio()")

    assert result.returncode == 0, result.stderr.decode(errors="replace")[-600:]
    out = result.stdout.decode("utf-8")
    assert "ABCD-EFGH" in out
    assert "█" in out or "▀" in out or "▄" in out, "the QR code should render as UTF-8 block glyphs"
