"""Instance data lives in the instance: nothing new may be stored machine-wide under ``~/.flow``.

Every instance on a machine shares ``<flow_home>``. Anything one instance writes there is read
by every other: a shared wizard run made a fresh instance open onto another's answers, and a
shared project mapping would route a remote project to a local id that only exists in prod.
Per-instance state goes under ``InstanceSettings.instance_dir`` (or its ``logs_dir``), and a
record's state under its own data dir.

A path that genuinely belongs to the MACHINE needs the user's explicit approval and an entry in
``ALLOWED`` with its reason. Don't add one yourself; ask.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"

# `<flow_home> / "x"` or `Path.home() / ".flow" / "x"`: a child of the shared flow home.
MACHINE_WIDE = re.compile(r'(\bflow_home\)?\s*/\s*["\']|Path\.home\(\)\s*/\s*["\']\.flow["\']\s*/)')

ALLOWED: dict[str, str] = {
    # The layout owner (prod and test settings): derives instance_dir / global_dir from flow_home.
    "instance_settings/": "defines the flow_home layout itself",
    # Lists every instance's server.json under <flow_home>/instances; writes nothing.
    "discovery/flowpad_discovery.py": "enumerates running instances",
    # One id for the machine, by definition shared across instances.
    "cli/commands/connect_cmd.py": "machine enrollment id for `flow connect`",
    # Read-only comparison against the real instances root, writes nothing.
    "instances/manager.py": "refuses an unscoped sweep under a redirected root",
    # Recognises scratch cwd prefixes in transcripts; writes nothing.
    "builtin/worker_history.py": "matches transcript cwd prefixes",
}


def _offenders() -> list[str]:
    found = []
    for path in sorted(ROOT.rglob("*.py")):
        rel = path.relative_to(ROOT).as_posix()
        if any(rel.startswith(allowed) for allowed in ALLOWED) or "/migrations/" in f"/{rel}":
            continue
        for lineno, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
            code = line.split("#", 1)[0]
            if MACHINE_WIDE.search(code):
                found.append(f"{rel}:{lineno}: {line.strip()}")
    return found


def test_nothing_new_is_stored_under_the_shared_flow_home():
    offenders = _offenders()
    assert not offenders, (
        "machine-wide state under the shared flow home; put it under instance_dir "
        "(or ask the user and add an ALLOWED entry):\n" + "\n".join(offenders)
    )


def test_the_pattern_catches_both_spellings():
    assert MACHINE_WIDE.search('get_instance_settings().flow_home / "project_mapping.json"')
    assert MACHINE_WIDE.search('Path(settings.flow_home) / "capability-probes"')
    assert MACHINE_WIDE.search('Path.home() / ".flow" / "app-open-logs"')
    assert not MACHINE_WIDE.search('get_instance_settings().instance_dir / "capability-probes"')
