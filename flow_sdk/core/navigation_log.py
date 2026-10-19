"""SmartNavigationLog: every smart-navigation decision, collected as a row of a dataset in temp.

Off unless the instance preference ``preferences.advanced.smart_navigation_log`` is on. When it is, each
decision of the ``smart-navigator`` block is appended by FlowCall's block log (``log`` in its
``compute_op.json``, ``core/compute_op/call_log``) -- after the answer has gone out, so logging never
slows a navigation -- to this instance's log dataset:

    <FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/smart-navigation-log/   spec: navigator.dataset

Temp on purpose: the OS clears it now and then, so the log never grows without bound.

The SAME row kind as the shipped SmartNavigator eval set, so everything that reads that one --
the dataset editor, ``validate``, ``score``, the navigator eval (``flow_sdk.evals.run``) -- reads this one:

* ``input``   -- the request (``utterance`` + ``here``);
* ``context`` -- the search matches the decision was offered;
* ``output``  -- what was decided (route, target, verb, confidence);
* ``data``    -- what was done (``dock`` address or ``prompt``), the engine's reason and latency,
  and when;
* no ``ground_truth``: a person reviews the row in the editor and labels it.

Rows are ``train``: a log is a training set, and the reviewed ones can be promoted to ``eval``.
The folder is the natural key -- found by where it lives, created on the first logged decision.
"""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

from flow_sdk.core.log_dataset import TempLog, drain, spawn

NAME = "smart-navigation-log"
TITLE = "SmartNavigationLog"
SPEC = "navigator.dataset"

#: The writer, shared with every FlowCall log (``core/log_dataset``).
_LOG = TempLog(
    NAME, TITLE, SPEC,
    "Every smart-navigation decision while SmartNavigationLog is on: what was typed, where, what "
    "was offered and what was done. Review and label the rows to train and evaluate the navigator.",
)


def folder() -> Path:
    """Where this instance's SmartNavigationLog lives: Flowpad's TEMP folder, per instance.

    A log, not a document: it sits under ``FLOWPAD_TEMP_DIR`` (``$TMPDIR/flowpad_temp``), which the
    OS clears now and then (macOS: at reboot and files untouched for days). Rows worth keeping are
    reviewed and copied into a kept dataset (``promote`` / ``append``) before they age out.
    """
    return _LOG.folder()


def row_of(request: dict, outcome: Any, answer: Any) -> dict:
    """One decision as a ``navigator.dataset`` row."""
    did = {"address": outcome.address} if outcome.address else {}
    if outcome.prompt is not None:
        did["prompt"] = outcome.prompt
    return {
        "kind": "train",
        "input": request,
        "context": {"candidates": [c.model_dump(mode="json", exclude_none=True) for c in outcome.candidates]},
        "output": outcome.decision.model_dump(mode="json", exclude_none=True),
        "data": {
            **did,
            "reason": answer.reason,
            "latency_ms": round(answer.latency_ms, 1),
            # How the model decided (``navigator.run``): its full request and response.
            **({"run": answer.run.model_dump(mode="json", exclude_none=True)} if answer.run else {}),
            "logged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


async def _indexed() -> Any:
    """This instance's log as the index holds it (no rows read) -- None before its first row."""
    return await _LOG.indexed()


async def dataset() -> Any:
    """The SmartNavigationLog dataset, created on first use — to read, label and evaluate it."""
    return await _LOG.dataset()


async def address() -> str:
    """Where asking for the log takes you: the log open in the app that edits it, or -- when it was
    never on, so there is no log -- Preferences > Advanced, where the switch is."""
    from flow_sdk.core.navigation_decision import entity_app_address  # noqa: PLC0415

    log = await _indexed()
    return (await entity_app_address(f"dataset-{log.id}") if log is not None else None) or "/dock/preferences/advanced"


__all__ = ["NAME", "TITLE", "address", "dataset", "drain", "folder", "row_of"]
