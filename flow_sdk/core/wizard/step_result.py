"""What a step's agent RETURNED, read off a receipt it wrote.

A ``process`` step hands work to an agent. Until now the step's verdict was
"the worker reached a terminal state" — so an agent that installed nothing and
stopped cheerfully produced a ``completed`` step, and an agent that knew it had
failed had no way to say so. This module is the channel it was missing.

**Why a receipt and not the other three.** ``flow wizard <pid> close`` is the
product's only typed agent-authored result, and it is *frontend-terminated*:
``on_wizard_close`` emits an entity event and persists nothing, so a headless,
backend-launched step would need a bus subscriber, a correlation key, a durable
store and a race rule — to fetch a value the runner can read off disk in a
directory it already owns and already passes to the agent as its workdir. The
agent's last assistant message is prose: it cannot be typed, cannot be bound to
a later step, and cannot say "I failed". The graph-workflow node is the right
SHAPE (settle, then read a declared location) but its payload is that same
prose. The receipt is the one mechanism with a proven verdict rule in this tree
— ``ingest/drivers/agent.py`` reads one, and treats a MISSING receipt as a
failed run rather than an empty one, for exactly the reason that applies here.

Pure: stdlib only, no entity imports, no process imports. That is what keeps
the runner's tests seam-injected and in milliseconds.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Optional

#: The file a step's agent writes its result to.
RESULT_FILENAME = "result.json"

#: JSON-serialized cap for a RETURNED VALUE. Anything larger is an artifact,
#: not a value: it would ride the run record, and it becomes an environment
#: variable for every later step. Over the cap the agent is told to return a
#: path instead — the discipline the graph workflow's output listing embodies.
RESULT_VALUE_CAP = 4096

#: The one human sentence a step shows. Capped so a chatty agent cannot turn a
#: step row into a paragraph.
SUMMARY_CAP = 200

#: The vocabulary is `flow wizard … close`'s, verbatim (``wizard_cmd.py``), so
#: that if a Python subscriber for ``wizard.closed`` is ever built it feeds this
#: same reader instead of inventing a second dialect.
STATUS_DONE = "done"
STATUS_ERROR = "error"
STATUS_CANCEL = "cancel"
STATUSES = (STATUS_DONE, STATUS_ERROR, STATUS_CANCEL)


@dataclass(frozen=True)
class StepResult:
    """One agent's account of one step."""

    ok: bool
    #: The one line a person reads. The agent's own words when it gave any.
    summary: str = ""
    #: The value it returned under the step's declared ``output`` name.
    value: Any = None
    #: Why it failed — the agent's own message, or ours about its receipt.
    error: str = ""
    #: Where the receipt was looked for, kept even on failure so a person can
    #: go and read what (if anything) is there.
    path: str = ""


def receipt_path(workdir: Path, step_id: str) -> Path:
    """Where THIS step's agent leaves its result.

    Per step, not per run: two agentic steps in one wizard must not read each
    other's account, and the id is already the run's unique handle for a step.
    """
    return Path(workdir) / "steps" / step_id / RESULT_FILENAME


def result_contract(path: Path, output: str, shape: Any = None) -> str:
    """The ``## Your result`` block appended to a step's prompt.

    Injected by the runner rather than written by the wizard author: a contract
    the author has to remember to paste is one that half the steps will not
    have, and the failure of a missing receipt would then land on the agent.
    """
    expected = ""
    if shape is not None:
        try:
            expected = f"\n- `{output}` should be shaped like: `{json.dumps(shape)}`"
        except (TypeError, ValueError):  # a shape we cannot render is not worth failing over
            expected = ""
    return f"""

---
## Your result

This step is part of a wizard, and the wizard reads your result from a file —
not from your final message. When you are done, succeed or fail, write JSON to
exactly this path:

  {path}

On success:

  {{"status": "done", "summary": "<one sentence, what you did>",
    "data": {{"{output}": <the value>}}}}

On failure:

  {{"status": "error", "summary": "<one sentence>", "error": "<what went wrong>"}}

Rules:
- Write the file even when you fail. No file means the step FAILED and the
  wizard says so.
- `data.{output}` is required on success, and under {RESULT_VALUE_CAP} bytes of
  JSON. If what you produced is bigger than that, write it somewhere and return
  its path here instead.
- `status` is one of: {", ".join(f"`{s}`" for s in STATUSES)}.
- `summary` is one sentence, at most {SUMMARY_CAP} characters.{expected}
"""


def read_step_result(path: Path, *, output: str) -> StepResult:
    """Read one receipt and decide what it says.

    A MISSING receipt is a FAILED step, not an empty one — the distinction the
    ingest driver's reader makes, and for the same reason: "the agent produced
    nothing" must never read as "there was nothing to do".
    """
    where = str(path)
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return StepResult(False, error=f"the agent finished but wrote no result at {where}", path=where)

    try:
        data = json.loads(raw)
    except ValueError as exc:
        return StepResult(False, error=f"the agent's result is not valid JSON: {exc}", path=where)
    if not isinstance(data, dict):
        return StepResult(False, error="the agent's result is not a JSON object", path=where)

    summary = str(data.get("summary") or "")[:SUMMARY_CAP]
    status = str(data.get("status") or "")
    if status not in STATUSES:
        return StepResult(
            False, summary=summary,
            error=f"the agent's result declares no status (expected one of {', '.join(STATUSES)})",
            path=where,
        )
    if status in (STATUS_ERROR, STATUS_CANCEL):
        # The agent's OWN words. Reporting our sentence over its explanation
        # would throw away the only account of what actually went wrong.
        reported = str(data.get("error") or summary or "").strip()
        prefix = "the agent cancelled" if status == STATUS_CANCEL else "the agent reported failure"
        return StepResult(
            False, summary=summary,
            error=f"{prefix}: {reported}" if reported else prefix,
            path=where,
        )

    values = data.get("data")
    if not isinstance(values, dict) or output not in values:
        return StepResult(
            False, summary=summary,
            error=f"the agent finished without returning {output!r}",
            path=where,
        )
    value = values[output]
    try:
        size = len(json.dumps(value))
    except (TypeError, ValueError) as exc:
        return StepResult(False, summary=summary, error=f"{output!r} is not JSON-serializable: {exc}", path=where)
    if size > RESULT_VALUE_CAP:
        return StepResult(
            False, summary=summary,
            error=(f"{output!r} is {size} bytes, over the {RESULT_VALUE_CAP}-byte value cap — "
                   "return a path, not the payload"),
            path=where,
        )
    return StepResult(True, summary=summary, value=value, path=where)


def clear_receipt(path: Path) -> None:
    """Remove any previous run's receipt and make room for this one.

    Load-bearing: without it a stale receipt from an earlier run is read as this
    run's result, so a step that did nothing at all reports the last run's
    success. It is the nastiest bug this design can have and it is invisible.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.unlink(missing_ok=True)
    except OSError:  # a read-only workdir fails the read below, legibly
        pass
