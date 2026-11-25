"""What this repo carries under ``agentic-assets/`` is the project's business, never one person's.

A project's installed assets are setup requirements of the project and of every project that takes it
as a package (``docs/dependency-lifecycle.md``). So two things must not ride along in git:

* a person's message channel — it is theirs ("Me" in the add form), and a clone would ask everyone
  to connect it;
* a credential this repo requires — nothing here needs a secret to be set up, and a host project
  would be held on it (``github-pat`` did exactly that after its agent had left).
"""

from __future__ import annotations

import json
import subprocess
from functools import cache
from pathlib import Path

import pytest

from flow_sdk.ingest.driver_registry import load_driver

pytestmark = pytest.mark.timeout(30)  # do not increase without approval

REPO = Path(__file__).resolve().parents[2]
DRIVERS = REPO / "flow_sdk/system_projects/flowpad_assistant/agentic-assets/data_driver"


def _carried(pattern: str) -> list[Path]:
    """Every matching file git tracks or would add (``git add -A``)."""
    listed = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", pattern],
        cwd=REPO, capture_output=True, text=True, timeout=20,
    ).stdout
    return [REPO / line for line in listed.splitlines() if line.strip() and (REPO / line).is_file()]


@cache
def _sends(driver: str) -> bool:
    folder = DRIVERS / driver
    return folder.is_dir() and bool(load_driver(folder).sends)


def is_a_persons_channel(document: dict) -> bool:
    """A source of a driver that sends, with no agent owner in its file (a user owner is never written)."""
    return _sends(str(document.get("data_driver_name") or "")) and not str(document.get("owner") or "").startswith("agent-")


def test_no_persons_message_channel_is_carried_by_this_repo():
    found = [
        str(path.relative_to(REPO))
        for path in _carried("agentic-assets/data_source/*/data_source.json")
        if is_a_persons_channel(json.loads(path.read_text(encoding="utf-8")))
    ]
    assert not found, f"a person's message channel belongs to them, not to the project — move it out of the repo: {found}"


def test_this_repo_requires_no_credential():
    required = [
        f"{path.parent.name}: {name}"
        for path in _carried("agentic-assets/credential/*/credential.json")
        for name, var in (json.loads(path.read_text(encoding="utf-8")).get("vars") or {}).items()
        if (var or {}).get("required", "MUST") == "MUST"
    ]
    assert not required, f"a required credential here is asked of every project that packages this one: {required}"


def test_the_detector_tells_a_channel_from_a_data_source_and_an_agents_channel():
    channel = {"data_driver_name": "agent", "data_driver_config": {"connector": "linkedin"}}
    assert is_a_persons_channel(channel)
    assert not is_a_persons_channel({**channel, "owner": "agent-004f3ab7-d33b-48c0-ae0e-6e61e181a343"})
    assert not is_a_persons_channel({"data_driver_name": "rss"})
