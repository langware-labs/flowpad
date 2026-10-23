"""A committed ``data_source.json`` holds config, never a secret.

A configured data source is an installed asset of its project, so it is committed with it
(``docs/data-management/data-source-asset.md``). What it names — a mailbox address, a channel, a user
id — is config; what it signs in with lives in the credential store, keyed by scope + project +
variable. This test fails on any data source file git would carry that names a secret value.
"""

from __future__ import annotations

import json
import re
import subprocess
from pathlib import Path
from typing import Any, Iterator

import pytest

pytestmark = pytest.mark.timeout(30)  # do not increase without approval

REPO = Path(__file__).resolve().parents[2]
#: A key that names a secret: the value must be in the store, not the file.
SECRET_KEY = re.compile(r"(secret|token|password|passwd|api[_-]?key|private[_-]?key|client[_-]?secret)", re.I)


def _git(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(["git", *args], cwd=REPO, capture_output=True, text=True, timeout=20)


def _carried() -> list[Path]:
    """Every data_source.json git tracks or would add (``git add -A``)."""
    listed = _git("ls-files", "--cached", "--others", "--exclude-standard", "--", "*data_source.json").stdout
    return [REPO / line for line in listed.splitlines() if line.strip() and (REPO / line).is_file()]


def _secrets(value: Any, path: str = "") -> Iterator[str]:
    if isinstance(value, dict):
        for key, inner in value.items():
            where = f"{path}.{key}" if path else str(key)
            if SECRET_KEY.search(str(key)) and isinstance(inner, str) and inner.strip():
                yield where
            yield from _secrets(inner, where)
    elif isinstance(value, list):
        for i, inner in enumerate(value):
            yield from _secrets(inner, f"{path}[{i}]")


@pytest.fixture(scope="module", autouse=True)
def _in_a_checkout() -> None:
    if _git("rev-parse", "--is-inside-work-tree").stdout.strip() != "true":
        pytest.skip("not a git checkout")


def test_a_data_source_is_committed_with_its_project() -> None:
    probe = "agentic-assets/data_source/anything/data_source.json"
    assert _git("check-ignore", "-q", "--", probe).returncode != 0, f"{probe} is ignored: sources are installed assets"


def test_no_carried_data_source_holds_a_secret() -> None:
    found = {str(p.relative_to(REPO)): hits for p in _carried() if (hits := list(_secrets(json.loads(p.read_text()))))}
    assert not found, f"secret values in data source files (keep them in the credential store): {found}"


def test_the_check_sees_a_secret() -> None:
    assert list(_secrets({"data_driver_config": {"address": "a@b.c", "api_key": "sk-x"}})) == ["data_driver_config.api_key"]
    assert list(_secrets({"data_driver_config": {"address": "a@b.c", "token_env": ""}})) == []
