"""Per-version migration status tracking.

One JSON file per version at ``<flow_home>/global/migrations/migration_<version>.json``,
written via tempfile + ``os.replace`` for atomic transitions. The
coordinator's pid is tracked so a crashed-mid-run migration can be
identified and (per user directive) best-effort retried.

State machine
-------------

States: ``started``, ``running``, ``completed``, ``error``.

Transitions handled by callers via ``write()`` + ``decide_action()``:

- no file          → first run: write ``started``, then ``running`` once
                     the agent's transcript first appears, then
                     ``completed``/``error`` on termination.
- ``completed``    → no-op: skip.
- ``running``      → if coordinator pid is alive: another run is
  /``started``      in flight; caller exits 0 with a friendly message.
                     If pid is dead: orphan; best-effort retry per user
                     directive.
- ``error``        → best-effort retry per user directive.

The pid-alive heuristic is the SECONDARY guard. The PRIMARY guard against
concurrent ``flow migrate run`` invocations is ``filelock.FileLock`` on
the sibling ``migration_<version>.lock`` (acquired by the runner before
calling into this module).
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from enum import Enum
from pathlib import Path


class MigrationStatus(str, Enum):
    STARTED = "started"
    RUNNING = "running"
    COMPLETED = "completed"
    ERROR = "error"


class Decision(str, Enum):
    """What the runner should do based on the current on-disk state."""

    RUN = "run"                  # no file, or stale terminal state → execute
    SKIP_COMPLETED = "skip"      # already completed, return 0
    SKIP_IN_FLIGHT = "in_flight" # another live coordinator owns this run


@dataclass
class MigrationRecord:
    """One per-version migration status row.

    Persisted as JSON. Fields with ``None`` defaults are populated as the
    migration progresses through its state machine.
    """

    version: str
    status: str
    pid: int | None = None
    started_at: str | None = None
    transitioned_at: str | None = None
    claude_session_id: str | None = None
    ap_id: str | None = None
    error_msg: str | None = None
    duration_seconds: float | None = None

    @classmethod
    def fresh(cls, version: str, pid: int) -> "MigrationRecord":
        """Construct a new ``started`` record for ``version`` owned by ``pid``."""
        now = _utcnow()
        return cls(
            version=version,
            status=MigrationStatus.STARTED.value,
            pid=pid,
            started_at=now,
            transitioned_at=now,
        )

    def transition(
        self,
        status: MigrationStatus,
        *,
        claude_session_id: str | None = None,
        ap_id: str | None = None,
        error_msg: str | None = None,
    ) -> "MigrationRecord":
        """Return a copy with ``status`` and bookkeeping fields updated.

        ``duration_seconds`` is computed against ``started_at`` for terminal
        states. ``transitioned_at`` always advances.
        """
        now = _utcnow()
        duration = self.duration_seconds
        if status in (MigrationStatus.COMPLETED, MigrationStatus.ERROR) and self.started_at:
            try:
                started_dt = datetime.fromisoformat(self.started_at.replace("Z", "+00:00"))
                duration = (datetime.fromisoformat(now.replace("Z", "+00:00")) - started_dt).total_seconds()
            except ValueError:
                duration = None
        return MigrationRecord(
            version=self.version,
            status=status.value,
            pid=self.pid if status != MigrationStatus.COMPLETED and status != MigrationStatus.ERROR else None,
            started_at=self.started_at,
            transitioned_at=now,
            claude_session_id=claude_session_id or self.claude_session_id,
            ap_id=ap_id or self.ap_id,
            error_msg=error_msg if error_msg is not None else self.error_msg,
            duration_seconds=duration,
        )


def status_path(status_dir: Path, version: str) -> Path:
    """Return the per-version status file path."""
    return status_dir / f"migration_{version}.json"


def lock_path(status_dir: Path, version: str) -> Path:
    """Return the per-version filelock path (sibling of the status file)."""
    return status_dir / f"migration_{version}.lock"


def read(status_dir: Path, version: str) -> MigrationRecord | None:
    """Return the current record for ``version`` or None if no file."""
    p = status_path(status_dir, version)
    if not p.exists():
        return None
    try:
        data = json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    try:
        return MigrationRecord(**data)
    except TypeError:
        # Schema drift — treat as missing rather than crashing the runner.
        return None


def write(status_dir: Path, record: MigrationRecord) -> Path:
    """Atomically write ``record`` to the per-version status file.

    Mirrors the tempfile + ``os.replace`` pattern from
    ``flow_sdk/config.py:282-291`` (``save_server_info``).
    """
    status_dir.mkdir(parents=True, exist_ok=True)
    p = status_path(status_dir, record.version)
    payload = json.dumps(asdict(record), indent=2, sort_keys=True)
    # Use NamedTemporaryFile in the same dir so os.replace stays atomic
    # (cross-filesystem renames are NOT atomic).
    fd, tmp_path = tempfile.mkstemp(
        prefix=f".migration_{record.version}_",
        suffix=".tmp",
        dir=str(status_dir),
    )
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(payload)
        os.replace(tmp_path, str(p))
    except Exception:
        try:
            os.unlink(tmp_path)
        except OSError:
            pass
        raise
    return p


def list_all(status_dir: Path) -> list[MigrationRecord]:
    """Return all on-disk migration records, sorted by version string."""
    if not status_dir.exists():
        return []
    out: list[MigrationRecord] = []
    for path in sorted(status_dir.glob("migration_*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
            out.append(MigrationRecord(**data))
        except (OSError, json.JSONDecodeError, TypeError):
            continue
    return out


def decide_action(
    record: MigrationRecord | None,
    *,
    pid_alive: bool,
) -> Decision:
    """Pure state-machine: given a record (or None) and whether its pid is
    alive, return what the runner should do.

    Per user directive, ``error`` and orphaned ``started`` / ``running``
    states are best-effort retried.
    """
    if record is None:
        return Decision.RUN
    if record.status == MigrationStatus.COMPLETED.value:
        return Decision.SKIP_COMPLETED
    if record.status in (MigrationStatus.STARTED.value, MigrationStatus.RUNNING.value):
        return Decision.SKIP_IN_FLIGHT if pid_alive else Decision.RUN
    # status == ERROR — retry
    return Decision.RUN


def _utcnow() -> str:
    """ISO-8601 UTC timestamp with ``Z`` suffix."""
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
