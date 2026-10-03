"""``flow test run`` — run a test command and report its progress live, read off the runner.

::

    flow test run --activity qa/p02 -- uv run pytest tests/api/test_a.py::t1 tests/api/test_b.py::t2
    flow test run --activity qa/p05 --cwd ui --env FLOW_INSTANCE=qa-cycle -- \\
        npx vitest run --project api tests/api/x.test.ts -t "creates|lists|deletes"

The counts on the activity come from the RUNNER, never from whoever called this: a
reporter (pytest plugin / vitest reporter, added to the command here) appends test events
to a file, and this process turns them into Activity verbs four times a second. The
runner's exit code is the verdict:

==========  =====  =====================================================================
verdict     exit   the activity
==========  =====  =====================================================================
PASS        0      ``done("PASS · n/n")`` (unless ``--no-finish``)
RED         1      ``block("N failing")`` — the caller works the failures, then re-runs
NO_VERDICT  2      ``block("no verdict — …")`` — the runner exited ≠0 with no failed test
MISMATCH    3      ``block("plan said A, runner ran B")`` — the selection is not the plan
==========  =====  =====================================================================

A re-run on the same address starts the counts over (``rerun``), so a phase run again
after its fixes reads as the new run, not the sum of both.

Progress goes to the instance THIS process targets (its ``FLOW_INSTANCE``), never the
runner's: ``--env`` applies to the runner only, because a QA phase that points its tests at
a disposable instance still reports to the person watching on theirs. It is reported to
the whole box unless ``--subject`` says otherwise — work run for a person belongs on the
footer, not on the calling agent's own row.

The last line on stdout is the machine-read summary (verdict, counts, failures, log path).
The runner's own output goes to the log file, so the summary is the only thing to parse.
"""

from __future__ import annotations

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Any, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands import progress_cmd
from flow_sdk.cli.commands._common import EXIT_INVALID_ARG
from flow_sdk.cli.commands._common import fail as _fail
from flow_sdk.cli.commands._common import ok as _ok
from flow_sdk.testing import EVENTS_ENV

test_app = typer.Typer(help="Run tests with live progress on an activity.")

#: How often accumulated counts are pushed. The sampling rate of a live view, the same
#: as the emitter's coalescing interval — not a timeout or a retry budget.
FLUSH_INTERVAL_S = 0.25

PYTEST_PLUGIN = "flow_sdk.testing.pytest_progress"
VITEST_REPORTER = Path(__file__).resolve().parents[2] / "testing" / "vitest_progress_reporter.mjs"

EXIT_RED, EXIT_NO_VERDICT, EXIT_MISMATCH = 1, 2, 3


def with_reporter(cmd: "list[str]") -> "list[str]":
    """The command with this runner's progress reporter added; unchanged for a runner
    without one (its verdict is still its exit code — it just has no live counts)."""
    for i, word in enumerate(cmd):
        name = os.path.basename(word)
        if name in ("pytest", "py.test") or (word == "pytest" and i and cmd[i - 1] == "-m"):
            return [*cmd[: i + 1], "-p", PYTEST_PLUGIN, *cmd[i + 1 :]]
        if name == "vitest":
            return [*cmd, "--reporter=default", f"--reporter={VITEST_REPORTER}"]
    return list(cmd)


def runner_name(cmd: "list[str]") -> str:
    """What a person calls this runner — ``pytest``, ``vitest`` — not the whole argv, which
    carries absolute paths and selections the summary line already accounts for."""
    for word in cmd:
        name = os.path.basename(word)
        if name in ("pytest", "py.test", "vitest", "jest", "playwright"):
            return name
    return os.path.basename(cmd[0])


class Tally:
    """What the runner has reported so far. Fed event by event; read on every flush."""

    def __init__(self) -> None:
        self.collected = 0
        self.outcomes: "dict[str, str]" = {}
        self.failures: "list[dict[str, Any]]" = []
        self.current: "Optional[str]" = None
        self.new_failures: "list[dict[str, Any]]" = []

    def feed(self, event: "dict[str, Any]") -> None:
        kind = event.get("event")
        if kind == "collected":
            self.collected += int(event.get("n") or 0)
        elif kind == "start":
            self.current = event.get("id")
        elif kind == "result":
            test_id = str(event.get("id"))
            outcome = str(event.get("outcome"))
            if event.get("amend") and self.outcomes.get(test_id) == "failed":
                return  # already red; a teardown failure adds nothing
            self.outcomes[test_id] = outcome
            if outcome == "failed":
                failure = {"id": test_id, "message": event.get("message") or "failed"}
                self.failures.append(failure)
                self.new_failures.append(failure)

    def count(self, outcome: str) -> int:
        return sum(1 for o in self.outcomes.values() if o == outcome)

    @property
    def ran(self) -> int:
        return len(self.outcomes)


class Reporter:
    """Turns a tally into verbs on one address. A failed report never fails the run:
    progress is never the reason a test command breaks."""

    def __init__(self, path: str, subject: "Optional[str]") -> None:
        self.path = path
        self.subject = subject
        self.sent: "tuple[Any, ...]" = ()
        self.errors = 0

    def send(self, verb: str, **body: Any) -> "Optional[dict]":
        payload = {k: v for k, v in {**body, "subject_entity": self.subject}.items() if v is not None}
        try:
            resp = progress_cmd._local_post(progress_cmd._url(self.path, verb), json=payload, timeout=10)
            data = resp.json()
            if str(data.get("status", "")).lower() == "fail":
                self.errors += 1
                return None
            return data.get("data")
        except Exception:  # noqa: BLE001 — see the class docstring
            self.errors += 1
            return None

    def spec(self) -> "Optional[dict]":
        params = {"subject_entity": self.subject} if self.subject else {}
        try:
            data = progress_cmd._local_get(progress_cmd._url(self.path), params=params, timeout=10).json()
        except Exception:  # noqa: BLE001
            return None
        return data.get("data") if str(data.get("status", "")).lower() != "fail" else None

    def flush(self, tally: Tally, planned: "Optional[int]") -> None:
        for failure in tally.new_failures:
            self.send("inc_error", message=failure["message"], ref=failure["id"])
        tally.new_failures = []
        skipped = tally.count("skipped")
        state = (tally.collected, tally.count("passed"), skipped, tally.current)
        if state == self.sent:
            return
        if planned is None and tally.collected:
            self.send("total", value=tally.collected)
        self.send("set_progress", value={"done": tally.count("passed") + skipped, "skipped": skipped})
        if tally.current:
            self.send("current", value=tally.current)
        self.sent = state


def _read_new(fh: Any, tally: Tally) -> None:
    for line in fh.readlines():
        line = line.strip()
        if not line:
            continue
        try:
            tally.feed(json.loads(line))
        except ValueError:
            continue  # a torn last line is re-read whole on the next pass


def verdict_of(exit_code: int, tally: Tally, planned: "Optional[int]") -> "tuple[str, int, str]":
    """``(verdict, exit, sentence)`` — the exit code decides, the tally explains."""
    failed = len({f["id"] for f in tally.failures})
    passed, skipped = tally.count("passed"), tally.count("skipped")
    if exit_code == 0 and failed == 0:
        if planned is not None and tally.collected != planned:
            return "MISMATCH", EXIT_MISMATCH, f"plan said {planned}, runner ran {tally.collected}"
        tail = f" · {skipped} skipped" if skipped else ""
        return "PASS", 0, f"PASS · {passed}/{tally.collected or passed}{tail}"
    if failed:
        return "RED", EXIT_RED, f"{failed} failing · {passed} passed"
    return "NO_VERDICT", EXIT_NO_VERDICT, f"no verdict — runner exited {exit_code} with no failed test"


@test_app.command("run", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def run(
    ctx: typer.Context,
    activity: Annotated[str, typer.Option("--activity", help="Address to report on, e.g. 'qa/p02'.")],
    subject_entity: Annotated[Optional[str], typer.Option("--subject", help="TypeId, or 'none' (default) for the whole box.")] = progress_cmd.NO_SUBJECT,
    env: Annotated[Optional[list[str]], typer.Option("--env", help="K=V for the RUNNER only (repeatable).")] = None,
    cwd: Annotated[Optional[str], typer.Option("--cwd", help="Directory to run the command in.")] = None,
    log: Annotated[Optional[str], typer.Option("--log", help="Where the runner's output goes (default: a temp file).")] = None,
    finish: Annotated[bool, typer.Option("--finish/--no-finish", help="End the activity on PASS.")] = True,
) -> None:
    """Run the command after ``--`` and report its tests live on ``--activity``."""
    cmd = list(ctx.args)
    if not cmd:
        _fail(EXIT_INVALID_ARG, "NO_COMMAND", "a test command is required after '--'")

    reporter = Reporter(activity, progress_cmd._default_subject(subject_entity))
    before = reporter.spec()
    planned = before.get("total") if before else None
    if before and (before.get("done") or before.get("errors_count") or before.get("state") == "blocked"):
        reporter.send("rerun")
    reporter.send("message", message=f"running {runner_name(cmd)}")

    workdir = Path(tempfile.mkdtemp(prefix="flow-test-run-"))
    events = workdir / "events.jsonl"
    events.touch()
    log_path = Path(log) if log else workdir / "runner.log"
    runner_env = {**os.environ, EVENTS_ENV: str(events)}
    for pair in env or []:
        key, sep, value = pair.partition("=")
        if not sep:
            _fail(EXIT_INVALID_ARG, "BAD_ENV", f"--env takes K=V, got {pair!r}")
        runner_env[key] = value

    tally = Tally()
    with open(log_path, "w", encoding="utf-8") as out, open(events, encoding="utf-8") as fh:
        try:
            proc = subprocess.Popen(with_reporter(cmd), cwd=cwd, env=runner_env, stdout=out, stderr=subprocess.STDOUT)
        except OSError as exc:
            reporter.send("block", message=f"no verdict — cannot start the runner: {exc}")
            _fail(EXIT_NO_VERDICT, "RUNNER_NOT_STARTED", str(exc))
        while proc.poll() is None:
            _read_new(fh, tally)
            reporter.flush(tally, planned)
            time.sleep(FLUSH_INTERVAL_S)
        _read_new(fh, tally)
        reporter.flush(tally, planned)

    verdict, code, sentence = verdict_of(proc.returncode, tally, planned)
    # The run is over: nothing is in hand any more, whatever the verdict.
    reporter.send("current", value=None)
    if verdict == "PASS":
        if finish:
            reporter.send("done", message=sentence)
        else:
            reporter.send("message", message=sentence)
    else:
        reporter.send("block", message=sentence)

    _ok({
        "verdict": verdict,
        "exit_code": proc.returncode,
        "activity": activity,
        "planned": planned,
        "collected": tally.collected,
        "passed": tally.count("passed"),
        "failed": len({f["id"] for f in tally.failures}),
        "skipped": tally.count("skipped"),
        "failures": tally.failures,
        "log": str(log_path),
        "progress_errors": reporter.errors,
    })
    raise typer.Exit(code)


__all__ = ["test_app"]
