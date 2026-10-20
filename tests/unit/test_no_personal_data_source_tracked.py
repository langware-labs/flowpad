"""No configured data source is tracked in this repo.

A ``data_source.json`` holds the address of whoever set the source up (a mailbox, a user id).
In a user's own project it may travel with the repo; in THIS one it is a developer's local
setup, and the Save button's ``git add -A`` commits whatever ``.gitignore`` leaves visible —
a Gmail source reached main that way. ``/agentic-assets/data_source/`` is ignored here, so a
saved source stays on the machine; this test keeps it that way.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase without approval

REPO = Path(__file__).resolve().parents[2]
SOURCES = "agentic-assets/data_source"


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=20)


@pytest.fixture(scope="module", autouse=True)
def _in_a_checkout() -> None:
    if _git("rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        pytest.skip("not a git checkout")


def test_no_data_source_file_is_tracked() -> None:
    tracked = _git("ls-files", "--", SOURCES).stdout.split()
    assert not tracked, f"personal data source(s) committed: {tracked}"


def test_a_saved_data_source_is_ignored() -> None:
    probe = f"{SOURCES}/anything/data_source.json"
    assert _git("check-ignore", "-q", "--", probe).returncode == 0, f"{probe} would be committed by `git add -A`"
