"""ONE rule says whether a web app is up here: ``flow_sdk/core/webapp/readiness.py`` over ``webapp_setup``'s
ownership and health checks. A second place that decides it — a probe with its own status threshold, a cached
verdict, "something answers on that port" — is how the setup became flaky (docs/webapp-lifecycle.md). This test
fails on any new call site of the low-level probes outside the places that own them, or listed below with a reason.
"""

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"

#: The calls that answer "is it up" at the lowest level.
PROBES = re.compile(r"\b(health_answers|loopback_answers|probe_webapp|start_app_check|page_was_clean|answers_now)\(")

#: Where the rule itself lives.
OWNERS = {
    "core/webapp/readiness.py", "builtin/webapp_setup.py", "core/dev_server.py", "core/app_ports.py",
    "core/webapp_probe.py",
}

#: Approved exceptions: (file) -> why it is not a readiness decision.
EXCEPTIONS = {
    # A diagnosis for a person ("refused", "hung", "blank") of an endpoint's port, not a verdict anything acts on.
    "builtin/service_endpoint.py": "probe action: diagnosis text for the display, never a readiness decision",
    # An endpoint that serves no web app (a bare port, an API) has no record to read.
    "core/navigate.py": "a non-app endpoint has no lifecycle record; web apps go through readiness.quick",
    # An ad-hoc folder with no webapp.json is not a web app asset (test_one_app_flow names the same exception).
    "cli/commands/app_cmd.py": "ad-hoc folder with no webapp.json: no record exists",
}


def test_no_second_ready_rule():
    offenders = []
    for path in ROOT.rglob("*.py"):
        rel = path.relative_to(ROOT).as_posix()
        if rel.startswith(("server/static/", "system_projects/")) or rel in OWNERS or rel in EXCEPTIONS:
            continue
        for number, line in enumerate(path.read_text(errors="ignore").splitlines(), 1):
            if PROBES.search(line) and not line.lstrip().startswith(("def ", "#")):
                offenders.append(f"{rel}:{number}: {line.strip()}")
    assert not offenders, "a second 'is the app up' rule:\n" + "\n".join(offenders)


def test_every_exception_still_needs_its_entry():
    stale = [rel for rel in EXCEPTIONS
             if not any(PROBES.search(line) for line in (ROOT / rel).read_text().splitlines()
                        if not line.lstrip().startswith(("def ", "#")))]
    assert not stale, f"exceptions no longer needed (remove them): {stale}"


def test_no_kept_verdict_survives_in_memory():
    """The load module keeps no web-app verdict of its own: the record is the state."""
    load = (ROOT / "core/setup/load.py").read_text()
    for gone in ("def validate(", "_AUDITS", "def _audit(", "fix_on_load"):
        assert gone not in load, gone
