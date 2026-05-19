#!/usr/bin/env python3
"""Read-only worker-status scanner for local Claude/Codex session JSONL files.

This is a diagnostic/test-side script. It does not write records or change
status behavior. It answers two questions across many session files:

1. What does the current production tail-status helper report?
2. For Codex rollout files, is there enough tail evidence to derive a richer
   WorkerStatus if the production path learned that transcript shape?

Examples:

    python scripts/validate_worker_status_sessions.py --worker codex --limit 200
    python scripts/validate_worker_status_sessions.py --worker both --expect-status complete
    python scripts/validate_worker_status_sessions.py \
      --worker codex \
      --codex-root tests/unit/resources/transcripts \
      --codex-glob "*.jsonl" \
      --expect-status complete
"""

from __future__ import annotations

import argparse
import json
import sys
import time
from collections import Counter, defaultdict
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from flow_sdk.builtin.agentic_process.cli_drivers.codex.status import codex_tail_status
from flow_sdk.fs_records.agent_status import WorkerStatus, _tail_status
from flow_sdk.instance_settings import get_instance_settings


DEFAULT_TAIL_BYTES = 64 * 1024
DEFAULT_ACTIVE_SECONDS = 300

NON_EVIDENCE_STATUSES = {
    WorkerStatus.IDLE.value,
    WorkerStatus.INITIALIZING.value,
    WorkerStatus.UNKNOWN.value,
}

CODEX_TOOL_CALL_ITEMS = {
    "function_call",
    "custom_tool_call",
    "local_shell_call",
    "tool_call",
    "web_search_call",
    "tool_search_call",
}

CODEX_TOOL_OUTPUT_ITEMS = {
    "function_call_output",
    "custom_tool_call_output",
    "tool_output",
    "tool_search_output",
}

CODEX_TOOL_BEGIN_EVENTS = {
    "exec_command_begin",
    "mcp_tool_call_begin",
    "patch_apply_begin",
}

CODEX_TOOL_END_EVENTS = {
    "exec_command_end",
    "mcp_tool_call_end",
    "patch_apply_end",
}

CODEX_COMPLETE_EVENTS = {
    "turn.completed",
    "task_complete",
}

CODEX_INTERRUPTED_EVENTS = {
    "turn_aborted",
}


@dataclass
class SessionSample:
    worker: str
    path: str
    session_id: str | None
    cwd: str | None
    mtime: str
    size: int
    production_status: str
    diagnostic_status: str
    diagnostic_signal: str

    @property
    def mismatch(self) -> bool:
        return self.production_status != self.diagnostic_status


def _parse_args() -> argparse.Namespace:
    settings = get_instance_settings()
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--worker",
        choices=("codex", "claude", "both"),
        default="codex",
        help="Which worker session roots to scan.",
    )
    parser.add_argument(
        "--limit",
        type=int,
        default=200,
        help="Max files per worker after newest-first sorting. Use 0 for all.",
    )
    parser.add_argument(
        "--codex-root",
        type=Path,
        default=settings.codex_sessions_dir,
        help="Root containing Codex rollout JSONL files.",
    )
    parser.add_argument(
        "--claude-root",
        type=Path,
        default=settings.claude_projects_dir,
        help="Root containing Claude project session JSONL files.",
    )
    parser.add_argument(
        "--codex-glob",
        default="rollout-*.jsonl",
        help="Recursive glob for Codex files under --codex-root.",
    )
    parser.add_argument(
        "--claude-glob",
        default="*.jsonl",
        help="Recursive glob for Claude files under --claude-root.",
    )
    parser.add_argument(
        "--tail-bytes",
        type=int,
        default=DEFAULT_TAIL_BYTES,
        help="Bytes to read from the end of each file for diagnostic classification.",
    )
    parser.add_argument(
        "--active-seconds",
        type=int,
        default=DEFAULT_ACTIVE_SECONDS,
        help="mtime freshness window used to decide active vs inactive.",
    )
    parser.add_argument(
        "--examples",
        type=int,
        default=3,
        help="Examples to print per diagnostic status and mismatch bucket.",
    )
    parser.add_argument(
        "--min-sessions",
        type=int,
        default=1,
        help="Fail if fewer sessions are scanned across selected workers.",
    )
    parser.add_argument(
        "--expect-status",
        default="",
        help="Comma-separated diagnostic statuses that must appear, e.g. complete,tool_running.",
    )
    parser.add_argument(
        "--fail-on-mismatch",
        action="store_true",
        help="Fail if production_status differs from diagnostic_status.",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="Emit machine-readable JSON instead of text.",
    )
    return parser.parse_args()


def _mtime_iso(path: Path) -> str:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return ""


def _iter_newest(root: Path, pattern: str, limit: int) -> list[Path]:
    if not root.is_dir():
        return []
    files: list[tuple[float, Path]] = []
    for path in root.rglob(pattern):
        if not path.is_file():
            continue
        try:
            files.append((path.stat().st_mtime, path))
        except OSError:
            continue
    files.sort(key=lambda item: item[0], reverse=True)
    if limit > 0:
        files = files[:limit]
    return [path for _, path in files]


def _read_head_entries(path: Path, max_lines: int = 32) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for _, line in zip(range(max_lines), fh):
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if isinstance(raw, dict):
                    entries.append(raw)
    except OSError:
        pass
    return entries


def _read_tail_entries(path: Path, tail_bytes: int) -> list[dict[str, Any]]:
    try:
        size = path.stat().st_size
        with path.open("rb") as fh:
            if size > tail_bytes:
                fh.seek(size - tail_bytes)
            chunk = fh.read().decode("utf-8", errors="replace")
    except OSError:
        return []

    entries: list[dict[str, Any]] = []
    for line in chunk.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            raw = json.loads(line)
        except json.JSONDecodeError:
            # The first line can be partial when we seek into the tail.
            continue
        if isinstance(raw, dict):
            entries.append(raw)
    return entries


def _session_meta(worker: str, path: Path) -> tuple[str | None, str | None]:
    sid: str | None = None
    cwd: str | None = None
    for raw in _read_head_entries(path):
        if worker == "codex":
            rtype = raw.get("type")
            if rtype == "session_meta":
                payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
                sid = sid or _as_str(payload.get("id"))
                cwd = cwd or _as_str(payload.get("cwd"))
            elif rtype == "thread.started":
                sid = sid or _as_str(raw.get("thread_id"))
            if sid and cwd:
                break
        else:
            sid = sid or _as_str(raw.get("sessionId") or raw.get("session_id"))
            cwd = cwd or _as_str(raw.get("cwd"))
            if sid and cwd:
                break
    return sid, cwd


def _as_str(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)
    return text if text else None


def _is_active(path: Path, active_seconds: int) -> bool:
    try:
        return (time.time() - path.stat().st_mtime) <= active_seconds
    except OSError:
        return False


def _codex_production_status(path: Path) -> WorkerStatus:
    return codex_tail_status(path)


def _claude_production_status(path: Path) -> WorkerStatus:
    return _tail_status(path)


def _codex_diagnostic_status(
    path: Path,
    *,
    tail_bytes: int,
    active_seconds: int,
) -> tuple[WorkerStatus, str]:
    """Rollout-aware Codex tail classifier for diagnostics.

    Production Codex status currently understands process-local stream events.
    This diagnostic classifier additionally recognizes common rollout signals
    from ``~/.codex/sessions`` so we can validate whether status evidence exists
    in those files without changing runtime behavior.
    """
    try:
        path.stat()
    except OSError:
        return WorkerStatus.INITIALIZING, "missing-file"

    entries = _read_tail_entries(path, tail_bytes)
    if not entries:
        return WorkerStatus.INITIALIZING, "no-parseable-tail"

    active = _is_active(path, active_seconds)
    fallback: tuple[WorkerStatus, str] | None = None
    for raw in reversed(entries):
        status, signal, terminal = _classify_codex_entry(raw)
        if status is None:
            continue
        if terminal:
            return status, signal
        if active:
            return status, signal
        fallback = (WorkerStatus.INACTIVE, f"stale-after:{signal}")
        break

    if fallback:
        return fallback
    if not active:
        return WorkerStatus.INACTIVE, "stale-no-status-signal"
    return WorkerStatus.UNKNOWN, "active-no-status-signal"


def _classify_codex_entry(
    raw: dict[str, Any],
) -> tuple[WorkerStatus | None, str, bool]:
    rtype = _as_str(raw.get("type")) or ""

    # Process-local stream-event shape.
    if rtype == "turn.completed":
        return WorkerStatus.COMPLETE, "stream:turn.completed", True
    if rtype in {"error", "turn.failed", "item.failed"}:
        return WorkerStatus.ERROR, "stream:error", True
    if rtype in {"turn.aborted", "interrupt"}:
        return WorkerStatus.INTERRUPTED, f"stream:{rtype}", True
    if rtype == "thread.started":
        return WorkerStatus.INITIALIZING, "stream:thread.started", False
    if rtype == "turn.started":
        return WorkerStatus.WAITING, "stream:turn.started", False
    if rtype == "item.started":
        item = raw.get("item") if isinstance(raw.get("item"), dict) else {}
        item_type = _as_str(item.get("type")) or "unknown"
        if item_type == "command_execution":
            return WorkerStatus.TOOL_RUNNING, "stream:item.started:command_execution", False
        if item_type in {"file_change", "agent_message"}:
            return WorkerStatus.TOOL_CALL, f"stream:item.started:{item_type}", False
        return WorkerStatus.THINKING, f"stream:item.started:{item_type}", False

    # Codex rollout shape.
    if rtype == "event_msg":
        payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        event_type = _as_str(payload.get("type")) or "unknown"
        if event_type in CODEX_COMPLETE_EVENTS:
            return WorkerStatus.COMPLETE, f"rollout:event_msg:{event_type}", True
        if event_type in CODEX_INTERRUPTED_EVENTS:
            return WorkerStatus.INTERRUPTED, f"rollout:event_msg:{event_type}", True
        if "error" in event_type:
            return WorkerStatus.ERROR, f"rollout:event_msg:{event_type}", True
        if event_type in CODEX_TOOL_BEGIN_EVENTS or event_type.endswith("_begin"):
            return WorkerStatus.TOOL_RUNNING, f"rollout:event_msg:{event_type}", False
        if event_type in CODEX_TOOL_END_EVENTS or event_type.endswith("_end"):
            return WorkerStatus.THINKING, f"rollout:event_msg:{event_type}", False
        if event_type == "task_started":
            return WorkerStatus.WAITING, "rollout:event_msg:task_started", False
        return None, f"rollout:event_msg:{event_type}", False

    if rtype == "response_item":
        payload = raw.get("payload") if isinstance(raw.get("payload"), dict) else {}
        item_type = _as_str(payload.get("type")) or "unknown"
        role = _as_str(payload.get("role")) or ""
        phase = _as_str(payload.get("phase")) or ""
        if item_type == "message":
            if role == "user":
                return WorkerStatus.WAITING, "rollout:response_item:message:user", False
            if role in {"assistant", "developer"}:
                if phase == "final_answer":
                    return WorkerStatus.COMPLETE, "rollout:response_item:assistant:final_answer", True
                return WorkerStatus.THINKING, f"rollout:response_item:message:{role}", False
        if item_type in CODEX_TOOL_CALL_ITEMS:
            return WorkerStatus.TOOL_CALL, f"rollout:response_item:{item_type}", False
        if item_type in CODEX_TOOL_OUTPUT_ITEMS:
            return WorkerStatus.THINKING, f"rollout:response_item:{item_type}", False
        if item_type == "reasoning":
            return WorkerStatus.THINKING, "rollout:response_item:reasoning", False
        return None, f"rollout:response_item:{item_type}", False

    if rtype == "turn_context":
        return WorkerStatus.INITIALIZING, "rollout:turn_context", False
    if rtype == "session_meta":
        return WorkerStatus.INITIALIZING, "rollout:session_meta", False
    if rtype == "token_count":
        return None, "rollout:token_count", False

    return None, f"unknown:{rtype or '<missing>'}", False


def _sample_for(
    worker: str,
    path: Path,
    *,
    tail_bytes: int,
    active_seconds: int,
) -> SessionSample:
    sid, cwd = _session_meta(worker, path)
    try:
        size = path.stat().st_size
    except OSError:
        size = 0

    if worker == "codex":
        production = _codex_production_status(path)
        diagnostic, signal = _codex_diagnostic_status(
            path,
            tail_bytes=tail_bytes,
            active_seconds=active_seconds,
        )
    else:
        production = _claude_production_status(path)
        diagnostic = production
        signal = "claude:_tail_status"

    return SessionSample(
        worker=worker,
        path=str(path),
        session_id=sid,
        cwd=cwd,
        mtime=_mtime_iso(path),
        size=size,
        production_status=production.value,
        diagnostic_status=diagnostic.value,
        diagnostic_signal=signal,
    )


def _scan(args: argparse.Namespace) -> list[SessionSample]:
    selected = ("codex", "claude") if args.worker == "both" else (args.worker,)
    samples: list[SessionSample] = []

    if "codex" in selected:
        for path in _iter_newest(args.codex_root, args.codex_glob, args.limit):
            samples.append(
                _sample_for(
                    "codex",
                    path,
                    tail_bytes=args.tail_bytes,
                    active_seconds=args.active_seconds,
                )
            )

    if "claude" in selected:
        for path in _iter_newest(args.claude_root, args.claude_glob, args.limit):
            samples.append(
                _sample_for(
                    "claude",
                    path,
                    tail_bytes=args.tail_bytes,
                    active_seconds=args.active_seconds,
                )
            )

    return samples


def _report_json(samples: list[SessionSample], errors: list[str]) -> None:
    print(json.dumps(_summary_payload(samples, errors), indent=2, sort_keys=True))


def _summary_payload(samples: list[SessionSample], errors: list[str]) -> dict[str, Any]:
    by_worker: dict[str, dict[str, Any]] = {}
    for worker in sorted({s.worker for s in samples}):
        subset = [s for s in samples if s.worker == worker]
        by_worker[worker] = {
            "count": len(subset),
            "production_status_counts": dict(Counter(s.production_status for s in subset)),
            "diagnostic_status_counts": dict(Counter(s.diagnostic_status for s in subset)),
            "mismatch_count": sum(1 for s in subset if s.mismatch),
        }
    return {
        "count": len(samples),
        "by_worker": by_worker,
        "samples": [asdict(s) for s in samples],
        "errors": errors,
    }


def _report_text(samples: list[SessionSample], errors: list[str], examples: int) -> None:
    print("Worker status session scan")
    print(f"scanned sessions: {len(samples)}")
    print()

    for worker in sorted({s.worker for s in samples}):
        subset = [s for s in samples if s.worker == worker]
        print(f"{worker}: {len(subset)} session(s)")
        _print_counter("  production_status", Counter(s.production_status for s in subset))
        _print_counter("  diagnostic_status", Counter(s.diagnostic_status for s in subset))
        mismatch_count = sum(1 for s in subset if s.mismatch)
        print(f"  mismatches: {mismatch_count}")
        print()

        by_status: dict[str, list[SessionSample]] = defaultdict(list)
        for sample in subset:
            by_status[sample.diagnostic_status].append(sample)
        for status in sorted(by_status):
            print(f"  examples diagnostic_status={status}:")
            for sample in by_status[status][:examples]:
                print(_format_sample(sample, indent="    "))
            print()

        mismatches = [s for s in subset if s.mismatch]
        if mismatches:
            print("  mismatch examples:")
            for sample in mismatches[:examples]:
                print(_format_sample(sample, indent="    "))
            print()

    if errors:
        print("validation errors:")
        for error in errors:
            print(f"  - {error}")


def _print_counter(label: str, counter: Counter[str]) -> None:
    print(f"{label}:")
    if not counter:
        print("    <none>")
        return
    for status, count in counter.most_common():
        print(f"    {status}: {count}")


def _format_sample(sample: SessionSample, *, indent: str = "") -> str:
    sid = sample.session_id[:8] + "..." if sample.session_id else "<no-session-id>"
    cwd = sample.cwd or "<no-cwd>"
    return (
        f"{indent}{sample.diagnostic_status} "
        f"(production={sample.production_status}, signal={sample.diagnostic_signal}) "
        f"sid={sid} cwd={cwd} path={sample.path}"
    )


def _validate(samples: list[SessionSample], args: argparse.Namespace) -> list[str]:
    errors: list[str] = []
    if len(samples) < args.min_sessions:
        errors.append(f"expected at least {args.min_sessions} session(s), found {len(samples)}")

    expected = {
        item.strip()
        for item in (args.expect_status or "").split(",")
        if item.strip()
    }
    if expected:
        seen = {s.diagnostic_status for s in samples}
        missing = sorted(expected - seen)
        if missing:
            errors.append(
                "missing expected diagnostic status(es): "
                + ", ".join(missing)
                + f" (seen: {', '.join(sorted(seen)) or '<none>'})"
            )

    observed = {
        s.diagnostic_status
        for s in samples
        if s.diagnostic_status not in NON_EVIDENCE_STATUSES
    }
    if samples and not observed:
        errors.append("no diagnostic worker status evidence beyond idle/initializing/unknown")

    if args.fail_on_mismatch:
        mismatch_count = sum(1 for s in samples if s.mismatch)
        if mismatch_count:
            errors.append(f"production/diagnostic mismatch count: {mismatch_count}")

    return errors


def main() -> int:
    args = _parse_args()
    samples = _scan(args)
    errors = _validate(samples, args)
    if args.json:
        _report_json(samples, errors)
    else:
        _report_text(samples, errors, args.examples)
    return 1 if errors else 0


if __name__ == "__main__":
    raise SystemExit(main())
