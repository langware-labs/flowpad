"""Detect the real Codex TUI session created after the first prompt."""

from __future__ import annotations

import asyncio
import json
import re
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.indexer.functions.codex_sessions import (
    discover_codex_session_paths_iter,
    extract_codex_session_from_path,
)


_HEAD_LINES = 256


@dataclass(frozen=True)
class CodexDetectedSession:
    session_id: str
    path: str
    cwd: str
    first_prompt: str
    timestamp: str | None


@dataclass(frozen=True)
class _Candidate:
    session_id: str
    path: Path
    cwd: str
    first_prompt: str
    timestamp: datetime | None
    sort_time: float


def _normalize_prompt(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def _parse_datetime(value: Any) -> datetime | None:
    if value is None:
        return None
    if isinstance(value, datetime):
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc)
    if isinstance(value, (int, float)):
        return datetime.fromtimestamp(float(value), tz=timezone.utc)
    if not isinstance(value, str) or not value.strip():
        return None
    raw = value.strip()
    try:
        if raw.endswith("Z"):
            raw = raw[:-1] + "+00:00"
        parsed = datetime.fromisoformat(raw)
        if parsed.tzinfo is None:
            parsed = parsed.replace(tzinfo=timezone.utc)
        return parsed.astimezone(timezone.utc)
    except ValueError:
        return None


def _same_path(left: str | None, right: str | Path | None) -> bool:
    if not left or not right:
        return False
    try:
        return Path(left).expanduser().resolve() == Path(right).expanduser().resolve()
    except OSError:
        return str(Path(left).expanduser()) == str(Path(right).expanduser())


def _text_from_content(content: Any) -> str:
    if isinstance(content, str):
        return content
    if isinstance(content, list):
        parts: list[str] = []
        for item in content:
            if isinstance(item, dict):
                text = item.get("text")
                if isinstance(text, str):
                    parts.append(text)
            elif isinstance(item, str):
                parts.append(item)
        return "\n".join(parts)
    return ""


def _read_candidate(path: Path) -> _Candidate | None:
    session_id = ""
    cwd = ""
    event_prompt = ""
    fallback_prompt = ""
    timestamp: datetime | None = None

    try:
        sort_time = path.stat().st_mtime
    except OSError:
        sort_time = 0.0

    try:
        with open(path, encoding="utf-8") as fh:
            for _, line in zip(range(_HEAD_LINES), fh):
                line = line.strip()
                if not line:
                    continue
                try:
                    raw = json.loads(line)
                except json.JSONDecodeError:
                    continue

                rtype = raw.get("type")
                payload = raw.get("payload") or {}
                if rtype == "session_meta":
                    if not timestamp:
                        timestamp = _parse_datetime(payload.get("timestamp") or raw.get("timestamp"))
                    if payload.get("id"):
                        session_id = str(payload["id"])
                    if payload.get("cwd"):
                        cwd = str(payload["cwd"])
                    continue

                if (
                    not event_prompt
                    and rtype == "event_msg"
                    and isinstance(payload, dict)
                    and payload.get("type") == "user_message"
                    and isinstance(payload.get("message"), str)
                ):
                    event_prompt = payload["message"]
                    if not timestamp:
                        timestamp = _parse_datetime(raw.get("timestamp"))
                    continue

                if (
                    not fallback_prompt
                    and rtype == "response_item"
                    and isinstance(payload, dict)
                    and payload.get("type") == "message"
                    and payload.get("role") == "user"
                ):
                    text = _text_from_content(payload.get("content"))
                    if text:
                        fallback_prompt = text
                        if not timestamp:
                            timestamp = _parse_datetime(raw.get("timestamp"))
    except OSError:
        return None

    if not session_id:
        try:
            record = extract_codex_session_from_path(path)
            session_id = record.session_id
            cwd = cwd or record.cwd
        except Exception:
            return None

    first_prompt = event_prompt or fallback_prompt
    if not session_id or not cwd or not first_prompt:
        return None

    if timestamp:
        sort_time = timestamp.timestamp()

    return _Candidate(
        session_id=session_id,
        path=path,
        cwd=cwd,
        first_prompt=first_prompt,
        timestamp=timestamp,
        sort_time=sort_time,
    )


def _find_matching_candidates(
    project: str | Path | None,
    first_prompt: str,
    *,
    sent_at: str | None = None,
    created_after: datetime | str | None = None,
    limit: int = 200,
) -> list[_Candidate]:
    target_prompt = _normalize_prompt(first_prompt)
    if not target_prompt:
        return []

    lower_bound = _parse_datetime(sent_at) or _parse_datetime(created_after)
    if lower_bound:
        lower_bound = lower_bound - timedelta(seconds=30)

    matches: list[_Candidate] = []
    for path in discover_codex_session_paths_iter(limit=limit) or []:
        candidate = _read_candidate(path)
        if not candidate:
            continue
        if project and not _same_path(candidate.cwd, project):
            continue
        if _normalize_prompt(candidate.first_prompt) != target_prompt:
            continue
        if lower_bound and candidate.timestamp and candidate.timestamp < lower_bound:
            continue
        matches.append(candidate)

    matches.sort(key=lambda item: item.sort_time, reverse=True)
    return matches


async def detect_session(
    project: str | Path | None,
    first_prompt: str,
    *,
    sent_at: str | None = None,
    created_after: datetime | str | None = None,
    timeout_seconds: float = 15.0,
    poll_seconds: float = 0.25,
    limit: int = 200,
) -> CodexDetectedSession | None:
    """Find the Codex rollout session for ``project`` and ``first_prompt``.

    Returns None when no unambiguous match is found before the timeout. If more
    than one recent rollout has the same cwd and first prompt, returning None is
    safer than binding the process to the wrong session.
    """
    deadline = asyncio.get_running_loop().time() + timeout_seconds
    while True:
        matches = _find_matching_candidates(
            project,
            first_prompt,
            sent_at=sent_at,
            created_after=created_after,
            limit=limit,
        )
        if len(matches) == 1:
            match = matches[0]
            return CodexDetectedSession(
                session_id=match.session_id,
                path=str(match.path),
                cwd=match.cwd,
                first_prompt=match.first_prompt,
                timestamp=match.timestamp.isoformat() if match.timestamp else None,
            )
        if len(matches) > 1:
            return None
        if asyncio.get_running_loop().time() >= deadline:
            return None
        await asyncio.sleep(poll_seconds)
