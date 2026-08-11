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

# The project a provisioned box should OPEN — once PER PERSON.
#
# When the hub sets a sandbox up it clones one or more projects in and then says
# which one the user meant. That answer has to reach each person who opens the
# box exactly once: `initSdk` only honours `default_project` when the client has
# no project of its own remembered, so re-asserting it would drag someone back to
# the starting project every time they refreshed. Handing it out once makes it an
# *opening* instruction rather than a standing preference.
#
# ONCE PER PERSON, not once per box, and that distinction is the whole point of
# this file's shape. A shared sandbox has a second reader: Alice provisions it and
# opens it, Bob is handed the link later. A single pop meant Alice's first load
# consumed the only copy and Bob — whose first visit the box cannot distinguish
# from Alice pressing refresh — landed on the ordinary default instead of the
# project the machine was made for. So consumption is recorded per hub user id,
# and the record is on DISK: the box restarts (it pauses on idle and resumes),
# and a handover that survives the sender's session must survive that too.
#
# Nobody signed in yet gets one anonymous slot, which is exactly the pre-handover
# behaviour: a box opened before any cloud login still opens on its project.
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


def _consumer_key() -> str:
    """Who is asking — the signed-in hub user id, or ``anonymous`` before login.

    Keying on the hub user (not a session or a browser) is what makes the
    instruction follow the PERSON: Bob signing in on the box Alice provisioned
    is a consumer the box has not served yet, whichever tab he opens it in.
    """
    try:
        from flow_sdk.cli.app_config import get_user  # noqa: PLC0415

        user = get_user()
        uid = user.get("id") if user else None
        return str(uid) if uid else "anonymous"
    except Exception:  # noqa: BLE001
        return "anonymous"


def set_pending_default_project(project_id: str | None) -> None:
    """Name the project this box opens on. ``None`` clears it.

    Resets the consumed-by roster: naming a (different) project is a fresh
    instruction, and everyone who opens the box afterwards should be served it.
    """
    with _opening_project_lock:
        if not project_id:
            _write_opening_project({})
            return
        _write_opening_project({"project_id": str(project_id), "consumed_by": []})


def take_pending_default_project() -> str | None:
    """Return the opening project for the CALLER, once, then remember they got it.

    Returns ``None`` for a caller already served — so their own refresh or a
    second tab lands on whatever they have since selected — while a person the
    box has not served yet still gets the project it was provisioned with.
    """
    with _opening_project_lock:
        record = _read_opening_project()
        project_id = record.get("project_id")
        if not project_id:
            return None
        consumer = _consumer_key()
        consumed = list(record.get("consumed_by") or [])
        if consumer in consumed:
            return None
        consumed.append(consumer)
        record["consumed_by"] = consumed
        _write_opening_project(record)
        return str(project_id)
