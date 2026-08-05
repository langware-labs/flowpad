"""
Shared state for the local server.
"""

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

# The project a freshly provisioned instance should OPEN — once.
#
# When the hub sets a sandbox up it clones one or more projects in and then says
# which one the user meant. The box carries that answer until the app first
# loads, and no further: `initSdk` only honours `default_project` when the client
# has no project of its own remembered, so a value that persisted would keep
# asserting itself on a machine where the user has since chosen something else.
# Handing it out exactly once makes it an *opening* instruction rather than a
# standing preference. Process memory for the same reason as everything else in
# this module: it describes this boot of this box.
pending_default_project_id: str | None = None


def set_pending_default_project(project_id: str | None) -> None:
    """Name the project the next bootstrap should open. ``None`` clears it."""
    global pending_default_project_id
    pending_default_project_id = str(project_id) if project_id else None


def take_pending_default_project() -> str | None:
    """Return the pending project id and forget it.

    Popping rather than reading is the whole mechanism: the second bootstrap —
    a refresh, or a second tab — gets the ordinary default and cannot overwrite
    whatever the user has selected in the meantime.
    """
    global pending_default_project_id
    project_id, pending_default_project_id = pending_default_project_id, None
    return project_id
