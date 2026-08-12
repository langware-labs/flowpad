"""
Shared state for the local server.
"""

import logging
import threading
from typing import Any, Dict

from .reporters import BufferReporter, ReporterRegistry, WebSocketReporter

# Shared state for login
login_result: Dict[str, Any] | None = None
login_received = threading.Event()

# Shared state for ping
ping_results = []
ping_received = threading.Event()

# Shared state for prompts
prompt_completions = []
prompt_received = threading.Event()

# Background Claude sessions
claude_sessions: Dict[str, Dict[str, Any]] = {}
session_counter = 0
session_lock = threading.Lock()

# Hook reporters
buffer_reporter = BufferReporter(max_size=100)
ws_reporter = WebSocketReporter()

# Reporter registry - manages active reporters
reporter_registry = ReporterRegistry()
reporter_registry.add(buffer_reporter)
reporter_registry.add(ws_reporter)

# The project a provisioned box should OPEN — once, then forgotten.
#
# When the hub sets a sandbox up it clones one or more projects in and then says
# which one the user meant. Handing that out exactly once makes it an *opening*
# instruction rather than a standing preference: `initSdk` only honours
# `default_project` when the client has no project of its own remembered, so
# re-asserting it would drag someone back to the starting project on every
# refresh.
#
# ONE-SHOT PER BOX, deliberately — this side cannot honestly do better. Every
# visitor reaches a sandbox through the SAME shared cookie-gate secret, so the
# second person to open it is indistinguishable from the first one refreshing.
# A shared box therefore needs its instruction RE-ARMED for each new person, and
# only the hub knows who is asking, because the hub authorized the request:
# `ComputeNode._rearm_opening_project_for` re-issues `set-default-project` right
# before it hands someone the machine. Do not try to re-derive the person here —
# an earlier attempt keyed on the box's own cloud login, which is one identity
# for the whole machine, so it read as the same consumer every time and changed
# nothing.
#
# On DISK rather than in memory because a sandbox pauses when idle and resumes:
# process state lost the instruction on every restart, including the gap between
# the hub arming it and the browser arriving.
_OPENING_PROJECT_FILE = "opening_project.json"
_opening_project_lock = threading.Lock()


def _opening_project_path():
    """``<instance_dir>/opening_project.json``. Lazy so importing this module
    doesn't resolve instance settings."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / _OPENING_PROJECT_FILE


def _read_opening_project() -> Dict[str, Any]:
    import json  # noqa: PLC0415

    try:
        return json.loads(_opening_project_path().read_text())
    except Exception:  # noqa: BLE001 — absent or unreadable means "no instruction"
        return {}


def _write_opening_project(record: Dict[str, Any]) -> None:
    import json  # noqa: PLC0415

    try:
        path = _opening_project_path()
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(record, indent=2))
    except Exception as err:  # noqa: BLE001
        logging.warning("[provisioning] could not persist the opening project: %s", err)


def set_pending_default_project(project_id: str | None) -> None:
    """Name the project the next bootstrap should open. ``None`` clears it.

    Called at provisioning, and again by the hub each time it hands the box to
    someone it has not sent there yet.
    """
    with _opening_project_lock:
        _write_opening_project({"project_id": str(project_id)} if project_id else {})


def take_pending_default_project() -> str | None:
    """Return the pending project id and forget it.

    Popping rather than reading is the mechanism: the next bootstrap — a refresh,
    or a second tab — gets the ordinary default and cannot overwrite whatever the
    user has selected in the meantime. A second PERSON is served by the hub
    re-arming this, not by anything decidable here.
    """
    with _opening_project_lock:
        project_id = _read_opening_project().get("project_id")
        if not project_id:
            return None
        _write_opening_project({})
        return str(project_id)
