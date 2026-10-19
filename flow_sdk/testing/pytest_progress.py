"""pytest plugin: append test events for ``flow test run`` (see :mod:`flow_sdk.testing`).

Loaded with ``-p flow_sdk.testing.pytest_progress``, which ``flow test run`` adds to a
pytest command. Writes nothing unless ``$FLOW_TEST_EVENTS`` names a file.
"""

from __future__ import annotations

import json
import os
from typing import Any, Optional

from flow_sdk.testing import EVENTS_ENV


def _write(event: "dict[str, Any]") -> None:
    path = os.environ.get(EVENTS_ENV)
    if not path:
        return
    # One line per write, opened per event: a line is never interleaved with another,
    # and nothing is buffered across a test that crashes the interpreter.
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(event) + "\n")


def _first_line(report: Any) -> "Optional[str]":
    crash = getattr(getattr(report, "longrepr", None), "reprcrash", None)
    text = getattr(crash, "message", None) or str(getattr(report, "longrepr", "") or "")
    line = next((ln.strip() for ln in text.splitlines() if ln.strip()), "")
    return line[:300] or None


def pytest_collection_finish(session: Any) -> None:
    _write({"event": "collected", "n": len(session.items)})


def pytest_runtest_logstart(nodeid: str, location: Any) -> None:
    _write({"event": "start", "id": nodeid})


def pytest_runtest_logreport(report: Any) -> None:
    """One result per test: the call phase decides, except that a setup that failed or
    skipped IS the test's outcome (there is no call), and a teardown failure turns a
    passed test red."""
    if report.when == "call" or (report.when == "setup" and not report.passed):
        outcome = "skipped" if report.skipped else ("passed" if report.passed else "failed")
        _write({
            "event": "result", "id": report.nodeid, "outcome": outcome,
            "message": _first_line(report) if outcome == "failed" else None,
        })
    elif report.when == "teardown" and report.failed:
        _write({"event": "result", "id": report.nodeid, "outcome": "failed",
                "message": "teardown: " + (_first_line(report) or "failed"), "amend": True})
