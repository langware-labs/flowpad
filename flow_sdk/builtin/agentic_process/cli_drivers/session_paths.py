"""Shared session/transcript path helpers for the vendor drivers.

Three vendors tee their stdout events into the SAME place — the process's
shadow dir — under a vendor-named file, and two of them ran the same
timestamp/path normalisation while matching a vendor session file to a launch.
Those are facts about FlowPad's own layout, not about any vendor, so they live
here once.

Not shared: ``load_session_history``. Each vendor's reader speaks its own event
vocabulary, and the shapes only look alike from a distance.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from pathlib import Path

#: How far BEFORE the recorded launch time a vendor session may be stamped and
#: still count as this launch's. Clock skew and the vendor's own start-up write
#: both land in this window. Not a retry or wait budget.
LAUNCH_LOOKBACK = timedelta(seconds=30)


def transcript_path_for_process(vendor_key: str, process_id: str) -> Path:
    """The process-local JSONL tee path for *vendor_key*'s stdout events.

    ``<shadow dir of the agentic_process>/<vendor_key>_transcript.jsonl``, with
    the directory created. ``shadow_dir_for`` is imported lazily so importing a
    driver does not pull the Record machinery.
    """
    from flow_sdk.fs_store.record_paths import shadow_dir_for  # noqa: PLC0415

    directory = shadow_dir_for("agentic_process", process_id)
    directory.mkdir(parents=True, exist_ok=True)
    return directory / f"{vendor_key}_transcript.jsonl"


def parse_iso_datetime(value: object) -> datetime | None:
    """A tz-aware datetime from an ISO string / datetime, else None.

    A naive value is read as UTC — every producer here stamps UTC, and a naive
    datetime compared against an aware one raises.
    """
    if not value:
        return None
    if isinstance(value, datetime):
        return value if value.tzinfo else value.replace(tzinfo=timezone.utc)
    if not isinstance(value, str):
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    return parsed if parsed.tzinfo else parsed.replace(tzinfo=timezone.utc)


def normalize_path(value: object) -> str | None:
    """A comparable absolute path string, or None.

    Falls back to the un-resolved expansion when the path cannot be resolved
    (a deleted cwd, a broken link) — a candidate must still be comparable.
    """
    if not value:
        return None
    try:
        return str(Path(str(value)).expanduser().resolve())
    except OSError:
        return str(Path(str(value)).expanduser())
