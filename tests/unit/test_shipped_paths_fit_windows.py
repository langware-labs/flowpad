"""Every file the wheel ships fits Windows' 260-char MAX_PATH once installed.

The regression (Windows, 2026-10-06): the SmartNavigator dataset shipped its kinds as data_specs
nested inside data_specs, 227 chars below the repo root -- 256-280 chars once under a real
``site-packages``. Listing them failed with WinError 3, so the first-start system-assets index
lost its shipped wizards and triggers, the setup wizard never ran and git was never installed.
Shipped assets stay flat; the budget leaves room for an install prefix of ~60 chars.
"""

from __future__ import annotations

import subprocess
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

REPO = Path(__file__).resolve().parents[2]
BUDGET = 200  # repo-relative, "flow_sdk/..." included


def test_no_shipped_path_is_deeper_than_the_budget():
    files = subprocess.run(
        ["git", "ls-files", "flow_sdk"], cwd=REPO, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    assert files, "git ls-files saw nothing -- not a checkout?"
    long = sorted((p for p in files if len(p) > BUDGET), key=len, reverse=True)
    assert not long, f"{len(long)} shipped paths exceed {BUDGET} chars, e.g. {long[0]} ({len(long[0])})"
