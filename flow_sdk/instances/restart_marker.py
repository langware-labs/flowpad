"""The in-place backend restart marker -- kept out of ``flow_sdk.builtin`` on purpose.

``flow instance restart-backend`` only has to write this file, and importing ``flow_sdk.builtin`` for it builds
the whole entity registry (~15 s): a restart used to cost more than the QA harness' 15 s budget for the command.
"""

from __future__ import annotations

from pathlib import Path

BACKEND_RESTART_MARKER_FILENAME = ".backend-restart-requested"


def request_backend_restart(instance_dir: Path, server_pid: int) -> Path:
    """Mark one exact backend generation for intentional replacement."""
    if server_pid <= 0:
        raise ValueError("server_pid must be positive")
    marker = instance_dir / BACKEND_RESTART_MARKER_FILENAME
    marker.parent.mkdir(parents=True, exist_ok=True)
    marker.write_text(str(server_pid))
    return marker
