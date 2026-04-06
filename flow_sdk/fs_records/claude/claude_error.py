"""ClaudeErrorRecord — persistent, deduplicated error triage records.

Errors are deduplicated by **fingerprint** (one record per unique error
pattern).  A sync step parses ``~/.claude/debug/*.txt`` via the
existing ``parse_debug_log()`` helper and upserts into a writable
``~/.flow/records/claude_error/``.

Each record tracks occurrence count, first/last seen timestamps, session
list, and a triage status (open / ignored / ignored_until / task_created).

ETL lives in ``sync_from_debug_logs()``.  ``discover()`` on ``ClaudeErrorRecord``
is pure disk read — no side effects.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import time
from datetime import datetime, timezone
from flow_sdk._compat import StrEnum
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_records.record_error import RecordError
from flow_sdk.fs_store import RecordType

from .claude_debug_log import (
    ClaudeSessionDebugLogRecord,
    _find_transcript,
    parse_debug_log,
)

# ─── Normalization helpers ────────────────────────────────────────────────────

_UUID_RE = re.compile(r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}", re.I)
_HEX_ADDR_RE = re.compile(r"0x[0-9a-fA-F]{6,}")
_TIMESTAMP_RE = re.compile(r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}[.\d]*Z?")
_PATH_RE = re.compile(r"(/[\w./-]+)+")
_DIGITS_RUN_RE = re.compile(r"\d{4,}")
# Matches API request/token IDs like req_011CYeki3KXBqWXJ5dMnKPsc, sk-ant-..., msg_..., etc.
_REQUEST_ID_RE = re.compile(r"\"(?:request_id|req_id|message_id)\":\s*\"[^\"]+\"")
_TOKEN_ID_RE = re.compile(r"\b(?:req|msg|sk|key|tok|ant)[-_][A-Za-z0-9]{10,}\b")
# Targeted quantity patterns — normalize counts but preserve error codes/status codes
_QUANTITY_PATTERNS = [
    re.compile(r"\b(\d+)\s+events?\b"),  # "44 events", "2 event"
    re.compile(r"attempt\s+(\d+)"),  # "attempt 3"
    re.compile(r"(\d+)\s+tokens?\b"),  # "28817 tokens"
    re.compile(r"(\d+)\s+errors?\b"),  # "5 errors"
    re.compile(r"(\d+)\s+items?\b"),  # "10 items"
    re.compile(r"(\d+)\s+files?\b"),  # "3 files"
    re.compile(r"(\d+)\s+retries?\b"),  # "2 retries"
    re.compile(r"(\d+)\s+times?\b"),  # "5 times"
]


def _normalize(text: str) -> str:
    """Strip variable parts for fingerprinting. Preserves error codes/status codes."""
    text = _UUID_RE.sub("<UUID>", text)
    text = _HEX_ADDR_RE.sub("<HEX>", text)
    text = _TIMESTAMP_RE.sub("<TS>", text)
    text = _REQUEST_ID_RE.sub("<REQ_ID>", text)
    text = _TOKEN_ID_RE.sub("<TOKEN>", text)
    text = _PATH_RE.sub("<PATH>", text)
    text = _DIGITS_RUN_RE.sub("<NUM>", text)
    for pat in _QUANTITY_PATTERNS:
        text = pat.sub(lambda m: m.group(0).replace(m.group(1), "<N>"), text)
    return text.strip()


def _fingerprint_hook(_hook: str, _event: str, root_cause: str) -> str:
    """Stable fingerprint for a hook error (keyed on root_cause only, not hook/event)."""
    key = f"hook:{_normalize(root_cause)}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


def _fingerprint_log(message: str) -> str:
    """Stable fingerprint for a log error."""
    key = f"log:{_normalize(message)}"
    return hashlib.sha256(key.encode()).hexdigest()[:12]


# ─── Status enum ──────────────────────────────────────────────────────────────


class ErrorStatus(StrEnum):
    OPEN = "open"
    IGNORED = "ignored"
    IGNORED_UNTIL = "ignored_until"
    TASK_CREATED = "task_created"


class ErrorCategory(StrEnum):
    HOOK = "hook"
    LOG = "log"


# ─── Fix suggestion ───────────────────────────────────────────────────────────


class Fix:
    """Cloud fix suggestion."""

    __slots__ = ("instruction", "message")

    def __init__(self, instruction: str = "", message: str = "") -> None:
        self.instruction = instruction or ""
        self.message = message or ""

    def to_dict(self) -> dict:
        return {"instruction": self.instruction, "message": self.message}

    @classmethod
    def from_dict(cls, d: object) -> "Fix":
        if isinstance(d, dict):
            return cls(d.get("instruction") or "", d.get("message") or "")
        return cls()


# ─── Record ───────────────────────────────────────────────────────────────────


class ClaudeErrorRecord(RecordError):
    """A deduplicated, triageable error record backed by ``~/.flow/records/claude_error/``."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_ERROR

    @classmethod
    def _rec_id_for_fingerprint(cls, fingerprint: str) -> str:
        """Return the deterministic record id for a given fingerprint."""
        import uuid as _uuid
        return str(_uuid.uuid5(_uuid.NAMESPACE_DNS, f"{RecordType.CLAUDE_ERROR}:{fingerprint}"))

    @classmethod
    def get_by_fingerprint(cls, fingerprint: str) -> "ClaudeErrorRecord | None":
        """Look up an error record by its fingerprint string."""
        return cls.discover_one(cls._rec_id_for_fingerprint(fingerprint))

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.CLAUDE_ERROR)
        # Common RecordError interface — mapped from ClaudeError fields
        kwargs.setdefault("error_message", kwargs.get("error_msg", ""))
        kwargs.setdefault("occurred_at", kwargs.get("first_seen", ""))
        kwargs.setdefault("trigger", "claude_debug")
        kwargs.setdefault("error_type", kwargs.get("error_category", ""))
        # Identity
        kwargs.setdefault("fingerprint", "")
        kwargs.setdefault("error_category", "")
        # Error content (from most recent occurrence)
        kwargs.setdefault("error_msg", "")
        kwargs.setdefault("hook", "")
        kwargs.setdefault("event", "")
        kwargs.setdefault("hooks", [])  # all distinct hook names seen across occurrences
        kwargs.setdefault("root_cause", "")
        kwargs.setdefault("traceback", [])
        # Occurrence tracking
        kwargs.setdefault("occurrence_count", 0)
        kwargs.setdefault("first_seen", "")
        kwargs.setdefault("last_seen", "")
        kwargs.setdefault("session_ids", [])
        kwargs.setdefault("last_session_id", "")
        kwargs.setdefault("last_jsonl_path", "")
        kwargs.setdefault("occurrences", [])
        # Triage
        kwargs.setdefault("error_status", ErrorStatus.OPEN)
        kwargs.setdefault("ignored_until", "")
        kwargs.setdefault("linked_task_id", "")
        kwargs.setdefault("worker_session_id", "")
        kwargs.setdefault("claude_session_id", "")
        kwargs.setdefault("triaged_at", "")
        kwargs.setdefault("notes", "")
        # Cloud fix suggestion (populated by apply-cloud-results action)
        fix_val = kwargs.pop("fix", None)
        kwargs["fix"] = fix_val if isinstance(fix_val, Fix) else Fix.from_dict(fix_val)
        super().__init__(**kwargs)

    def to_dict(self) -> dict:
        d = super().to_dict()
        if isinstance(fix := d.get("fix"), Fix):
            d["fix"] = fix.to_dict()
        return d

    @classmethod
    def from_dict(cls, data: dict) -> "ClaudeErrorRecord":
        rec = super().from_dict(data)
        rec_d = object.__getattribute__(rec, "__dict__")
        if not isinstance(rec_d.get("fix"), Fix):
            rec_d["fix"] = Fix.from_dict(rec_d.get("fix"))
        return rec


# ─── Sync state persistence ──────────────────────────────────────────────────


_SYNC_STATE_FILE = "_sync_state.json"
_MAX_OCCURRENCES = 50  # cap stored individual occurrences per fingerprint


def _load_sync_state(base: Path) -> dict:
    """Load sync state from ``<base>/_sync_state.json``."""
    p = base / _SYNC_STATE_FILE
    if p.exists():
        try:
            return json.loads(p.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            pass
    return {"processed": {}}


def _save_sync_state(base: Path, state: dict) -> None:
    """Persist sync state."""
    base.mkdir(parents=True, exist_ok=True)
    p = base / _SYNC_STATE_FILE
    p.write_text(json.dumps(state, indent=2), encoding="utf-8")


# ─── Debug log maintenance ───────────────────────────────────────────────────

_DEBUG_MAX_AGE_DAYS = 7
_DEBUG_SIZE_WARN_MB = 400


def _cleanup_and_measure_debug_dir() -> tuple[int, int, int]:
    """Single-pass: delete old debug logs and measure remaining size.

    Returns (removed_count, remaining_bytes, remaining_file_count).
    """
    debug_dir = ClaudeSessionDebugLogRecord.debug_dir()
    if not debug_dir.is_dir():
        return 0, 0, 0
    cutoff = time.time() - (_DEBUG_MAX_AGE_DAYS * 86400)
    removed = 0
    total_bytes = 0
    file_count = 0
    for entry in os.scandir(debug_dir):
        if not entry.name.endswith(".txt"):
            continue
        try:
            st = entry.stat()
            if st.st_mtime < cutoff:
                os.unlink(entry.path)
                removed += 1
            else:
                total_bytes += st.st_size
                file_count += 1
        except OSError:
            continue
    return removed, total_bytes, file_count


def _check_debug_dir_size(
    total_bytes: int,
    file_count: int,
) -> None:
    """If debug dir exceeds threshold, create an error record about it."""
    total_mb = total_bytes / (1024 * 1024)
    if total_mb <= _DEBUG_SIZE_WARN_MB:
        return
    fp = "debug-dir-size-warning"
    now_iso = datetime.now(timezone.utc).isoformat()
    upsert_error(
        fingerprint=fp,
        error_category=ErrorCategory.LOG,
        error_msg=(
            f"Claude debug log directory is {total_mb:.0f} MB "
            f"({file_count} files). "
            f"Consider deleting entries older than a week: "
            f"find ~/.claude/debug -name '*.txt' -mtime +7 -delete"
        ),
        hook="",
        event="",
        root_cause="disk-usage",
        traceback=[],
        timestamp=now_iso,
        session_id="system",
        jsonl_path="",
    )


# ─── Standalone ETL functions ─────────────────────────────────────────────────


def upsert_error(
    *,
    fingerprint: str,
    error_category: str,
    error_msg: str,
    hook: str,
    event: str,
    root_cause: str,
    traceback: list[str],
    timestamp: str,
    session_id: str,
    jsonl_path: str,
) -> None:
    """Create or update an error record by fingerprint."""
    rec_id = ClaudeErrorRecord._rec_id_for_fingerprint(fingerprint)
    existing = ClaudeErrorRecord.get_by_fingerprint(fingerprint)

    occurrence: dict = {
        "timestamp": timestamp,
        "session_id": session_id,
        "jsonl_path": jsonl_path,
        "error_msg": error_msg,
        "traceback": traceback,
    }
    if hook:
        occurrence["hook"] = hook
    if event:
        occurrence["event"] = event

    if existing is not None:
        # Track unique hook names across all occurrences of this fingerprint.
        # Do NOT save here; fold into the final save below to keep last_seen consistent.
        hooks_dirty = False
        if hook:
            current_hooks = getattr(existing, "hooks", None) or []
            if hook not in current_hooks:
                existing.hooks = current_hooks + [hook]
                hooks_dirty = True

        # Check for duplicate occurrence (same session + timestamp)
        for occ in existing.occurrences:
            if occ.get("session_id") == session_id and occ.get("timestamp") == timestamp:
                # Still persist if hooks changed so the backfill isn't lost
                if hooks_dirty:
                    existing.save()
                return

        existing.occurrence_count += 1
        if not existing.first_seen or timestamp < existing.first_seen:
            existing.first_seen = timestamp
        if not existing.last_seen or timestamp > existing.last_seen:
            existing.last_seen = timestamp
            existing.last_session_id = session_id
            existing.last_jsonl_path = jsonl_path
        # Update error content from latest occurrence
        existing.error_msg = error_msg
        existing.traceback = traceback
        if root_cause:
            existing.root_cause = root_cause
        # Track session
        if session_id and session_id not in existing.session_ids:
            existing.session_ids.append(session_id)
        # Append occurrence (capped)
        existing.occurrences.append(occurrence)
        if len(existing.occurrences) > _MAX_OCCURRENCES:
            existing.occurrences = existing.occurrences[-_MAX_OCCURRENCES:]
        # Re-open if a new occurrence fired after the ignored_until point
        if existing.error_status == ErrorStatus.IGNORED_UNTIL and existing.ignored_until:
            if timestamp > existing.ignored_until:
                existing.error_status = ErrorStatus.OPEN
                existing.ignored_until = ""
        existing.save()
    else:
        rec = ClaudeErrorRecord(
            id=rec_id,
            name=error_msg[:80] if error_msg else rec_id,
            fingerprint=fingerprint,
            error_category=error_category,
            error_msg=error_msg,
            hook=hook,
            event=event,
            hooks=[hook] if hook else [],
            root_cause=root_cause,
            traceback=traceback,
            occurrence_count=1,
            first_seen=timestamp,
            last_seen=timestamp,
            session_ids=[session_id] if session_id else [],
            last_session_id=session_id,
            last_jsonl_path=jsonl_path,
            occurrences=[occurrence],
            error_status=ErrorStatus.OPEN,
        )
        rec.save()


def sync_from_debug_logs(list_path: Path, hours: float = 168.0) -> None:
    """Parse debug logs and upsert error records into *list_path*.

    This is the ETL step: reads ``~/.claude/debug/*.txt``, deduplicates by
    fingerprint, and writes ``ClaudeErrorRecord`` files under *list_path*.

    Pure side-effecting function — call explicitly at startup or on-demand.
    ``ClaudeErrorRecord.discover()`` is a plain disk read with no sync.
    """
    import shutil

    debug_dir = ClaudeSessionDebugLogRecord.debug_dir()
    if not debug_dir.is_dir():
        return

    list_path.mkdir(parents=True, exist_ok=True)
    sync_state = _load_sync_state(list_path)
    processed: dict[str, float] = sync_state.get("processed", {})

    cutoff = time.time() - (hours * 3600)

    for entry in os.scandir(debug_dir):
        if not entry.name.endswith(".txt"):
            continue
        mtime = entry.stat().st_mtime
        if mtime < cutoff:
            continue
        session_id = Path(entry.name).stem
        prev_mtime = processed.get(session_id)
        if prev_mtime is not None and abs(prev_mtime - mtime) < 0.01:
            continue  # already processed at this mtime

        # Parse the debug log
        path = Path(entry.path)
        try:
            hook_errors, log_errors = parse_debug_log(path)
        except OSError:
            continue

        if not hook_errors and not log_errors:
            processed[session_id] = mtime
            continue

        jsonl_path = _find_transcript(session_id)

        # Upsert each hook error
        for he in hook_errors:
            fp = _fingerprint_hook(he.hook, he.event, he.root_cause)
            upsert_error(
                fingerprint=fp,
                error_category=ErrorCategory.HOOK,
                error_msg=he.root_cause or f"{he.hook} ({he.event}) error",
                hook=he.hook,
                event=he.event,
                root_cause=he.root_cause,
                traceback=he.traceback,
                timestamp=he.timestamp,
                session_id=session_id,
                jsonl_path=jsonl_path,
            )

        # Upsert each log error
        for le in log_errors:
            fp = _fingerprint_log(le.message)
            upsert_error(
                fingerprint=fp,
                error_category=ErrorCategory.LOG,
                error_msg=le.message,
                hook="",
                event="",
                root_cause="",
                traceback=[],
                timestamp=le.timestamp,
                session_id=session_id,
                jsonl_path=jsonl_path,
            )

        processed[session_id] = mtime

    # Check ignored_until expiry on all existing records
    now_iso = datetime.now(timezone.utc).isoformat()
    cutoff_iso = datetime.fromtimestamp(cutoff, tz=timezone.utc).isoformat()
    for rec in ClaudeErrorRecord.discover():
        # Auto-reopen expired snoozes — but only for real future snoozes, not
        # "ignore till now" (where ignored_until ≈ triaged_at, both set to the
        # same moment).  A real snooze always has ignored_until > triaged_at.
        if rec.error_status == ErrorStatus.IGNORED_UNTIL and rec.ignored_until:
            is_real_snooze = rec.triaged_at and rec.ignored_until > rec.triaged_at
            if is_real_snooze and rec.ignored_until <= now_iso:
                rec.error_status = ErrorStatus.OPEN
                rec.ignored_until = ""
                rec.save()
        # Prune records older than the time window
        if rec.last_seen and rec.last_seen < cutoff_iso:
            rd = rec.record_dir
            if rd and rd.exists():
                shutil.rmtree(rd, ignore_errors=True)

    sync_state["processed"] = processed
    sync_state["last_sync_ts"] = time.time()
    _save_sync_state(list_path, sync_state)
