"""SmartNavigationLog: every smart-navigation decision, collected as a row of a dataset in temp.

Off unless the instance preference ``preferences.advanced.smart_navigation_log`` is on. When it is, each
``navigation-decision`` answer is appended -- after the answer has gone out, so logging never
slows a navigation -- to this instance's log dataset:

    <FLOWPAD_TEMP_DIR>/<instance>/agentic-assets/dataset/smart-navigation-log/   spec: navigator.dataset

Temp on purpose: the OS clears it now and then, so the log never grows without bound.

The SAME row kind as the shipped SmartNavigator eval set, so everything that reads that one --
the dataset editor, ``validate``, ``score``, ``navigator_eval.evaluate`` -- reads this one:

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

import asyncio
import json
import logging
import weakref
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Optional

logger = logging.getLogger(__name__)

NAME = "smart-navigation-log"
TITLE = "SmartNavigationLog"
SPEC = "navigator.dataset"

#: One writer per event loop: ``append`` numbers examples by what is on disk, and an asyncio lock
#: belongs to the loop that first used it.
_locks: "weakref.WeakKeyDictionary[asyncio.AbstractEventLoop, asyncio.Lock]" = weakref.WeakKeyDictionary()
_pending: set[asyncio.Task] = set()


def _lock() -> asyncio.Lock:
    loop = asyncio.get_running_loop()
    if loop not in _locks:
        _locks[loop] = asyncio.Lock()
    return _locks[loop]


def folder() -> Path:
    """Where this instance's SmartNavigationLog lives: Flowpad's TEMP folder, per instance.

    A log, not a document: it sits under ``FLOWPAD_TEMP_DIR`` (``$TMPDIR/flowpad_temp``), which the
    OS clears now and then (macOS: at reboot and files untouched for days). Rows worth keeping are
    reviewed and copied into a kept dataset (``promote`` / ``append``) before they age out.
    """
    from flow_sdk import config  # noqa: PLC0415
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    instance = get_instance_settings().instance_name
    return Path(config.FLOWPAD_TEMP_DIR) / instance / "agentic-assets" / "dataset" / NAME


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
            "logged_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        },
    }


async def dataset() -> Any:
    """The SmartNavigationLog dataset, created on first use."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415

    where = folder()
    manifest = where / "dataset.json"
    if not manifest.exists():
        where.mkdir(parents=True, exist_ok=True)
        manifest.write_text(
            json.dumps(
                {
                    "metadata": {
                        "title": TITLE,
                        "description": "Every smart-navigation decision while SmartNavigationLog is on: "
                        "what was typed, where, what was offered and what was done. Review and label "
                        "the rows to train and evaluate the navigator.",
                        "data_layout": "io_folder",
                        "spec": SPEC,
                    },
                    "data": {},
                },
                indent=2,
            )
            + "\n"
        )
    return Dataset.at(where)


async def log(request: dict, outcome: Any, answer: Any) -> Optional[str]:
    """Append one decision (when the log is on); the new example id, else None. Never raises."""
    from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415
    from flow_sdk.preferences import smart_navigation_log_enabled  # noqa: PLC0415

    if not smart_navigation_log_enabled() or not (request.get("utterance") or "").strip():
        return None
    try:
        async with _lock():
            ds = await dataset()
            [example_id] = await ds.append([row_of(request, outcome, answer)])
            # The folder IS the record: re-index it (row + counts, a broadcast so the UI lists it).
            await reindex_paths([str(folder())])
        return example_id
    except Exception as exc:  # noqa: BLE001 -- a log must never break a navigation
        logger.warning("smart navigation log: could not append: %s", exc)
        return None


async def address() -> str:
    """Where asking for the log takes you: the log open in the app that edits it, or -- when it was
    never on, so there is no log -- Preferences > Advanced, where the switch is."""
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.builtin.faas.editors import editors_for  # noqa: PLC0415

    here = folder().resolve()  # the index stores the resolved path (/private/var/... on macOS)
    rows = await Dataset.get_all({"name": TITLE})
    log = next((r for r in rows if getattr(r, "asset_ref", None) and Path(r.asset_ref).resolve() == here), None)
    editors = await editors_for(log) if log is not None else []
    if not editors:
        return "/dock/preferences/advanced"
    return f"/dock/app/{editors[0]['typeid']}?subject=dataset-{log.id}"


def log_soon(request: dict, outcome: Any, answer: Any) -> None:
    """``log`` in the background -- the caller has its answer already."""
    task = asyncio.get_running_loop().create_task(log(request, outcome, answer))
    _pending.add(task)
    task.add_done_callback(_pending.discard)


async def drain() -> None:
    """Wait for the logs in flight (tests, shutdown)."""
    while _pending:
        await asyncio.gather(*list(_pending), return_exceptions=True)


__all__ = ["NAME", "TITLE", "address", "dataset", "drain", "folder", "log", "log_soon", "row_of"]
