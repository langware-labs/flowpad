"""Provider title observations. Priority and persistence belong to the shared FSM."""
from __future__ import annotations

import hashlib
import re
import sqlite3
from collections.abc import Sequence
from datetime import datetime
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

import yaml

from .state import NameObservation, NameOrigin

if TYPE_CHECKING:
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess


def _timestamp_ns(value: object) -> int | None:
    if isinstance(value, datetime):
        return int(value.timestamp() * 1_000_000_000)
    if isinstance(value, str):
        try:
            return int(datetime.fromisoformat(value.replace('Z', '+00:00')).timestamp() * 1_000_000_000)
        except ValueError:
            pass
    return None


class NamingAdapter(Protocol):
    def read(self, process: AgenticProcess) -> list[NameObservation]: ...
    def transcript_may_rename(self, entries: Sequence[object]) -> bool: ...


def _observation(process: AgenticProcess, title: object, origin: NameOrigin, source: str,
                 sequence: int | None = None, revision: str | None = None) -> NameObservation | None:
    if not process.session_id or not isinstance(title, str) or not title.strip():
        return None
    return NameObservation(title=title, origin=origin, source=source,
                           session_id=process.session_id, sequence=sequence,
                           revision=revision or hashlib.sha256(f'{sequence}:{title}'.encode()).hexdigest())


class MetadataNamingAdapter:
    """Titles are read from the provider's native store on a transcript event.

    A provider whose title lives outside the transcript cannot tell from the
    delivered entries whether it moved, so every event is a reason to read.
    """
    def transcript_may_rename(self, entries: Sequence[object]) -> bool:
        return True


class ClaudeNamingAdapter(MetadataNamingAdapter):
    #: Claude writes its title into the transcript itself; any other entry
    #: cannot have changed it.
    TITLE_KINDS = frozenset({"ai-title", "custom-title"})

    def transcript_may_rename(self, entries: Sequence[object]) -> bool:
        return any(getattr(entry, "meta_kind", None) in self.TITLE_KINDS for entry in entries)

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        from flow_sdk.assets.types.claude_titles import read_claude_title
        path = getattr(process, "transcript_path", None)
        title = read_claude_title(path) if path else None
        if title is None:
            return []
        item = _observation(process, title.title,
                            NameOrigin.EXPLICIT_USER if title.explicit else NameOrigin.HARNESS_AUTO,
                            'claude.metadata', title.sequence, title.revision)
        return [item] if item else []


class CodexNamingAdapter(MetadataNamingAdapter):
    def _source_path(self, process: AgenticProcess) -> Path | None:
        from flow_sdk.instance_settings import get_instance_settings
        return get_instance_settings().codex_session_index_path.resolve()

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        from flow_sdk.assets.types.codex_titles import read_codex_title

        title = read_codex_title(self._source_path(process), process.session_id)
        if title is None:
            return []
        # Codex persists exactly the same record for automatic and manual titles.
        item = _observation(process, title.title, NameOrigin.UNKNOWN,
                            'codex.session_index', title.sequence, title.revision)
        return [item] if item else []


class CopilotNamingAdapter(MetadataNamingAdapter):
    def _source_path(self, process: AgenticProcess) -> Path | None:
        from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import copilot_session_state_root
        return (copilot_session_state_root() / process.session_id / 'workspace.yaml').resolve() if process.session_id else None

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        path = self._source_path(process)
        if path is None:
            return []
        try:
            raw = yaml.safe_load(path.read_text(encoding='utf-8'))
            if not isinstance(raw, dict):
                return []
            named = raw.get('user_named')
            title = raw.get('name')
            # Same legacy migration as Copilot's native workspace reader.
            if not isinstance(title, str) or not title.strip():
                title = raw.get('summary')
                if named is None and isinstance(title, str) and title.strip():
                    named = False
            elif named is None and raw.get('summary'):
                named = True
            origin = (NameOrigin.EXPLICIT_USER if named is True else
                      NameOrigin.HARNESS_AUTO if named is False else NameOrigin.UNKNOWN)
            item = _observation(process, title, origin, 'copilot.workspace', _timestamp_ns(raw.get('updated_at')) or path.stat().st_mtime_ns)
            return [item] if item else []
        except (OSError, UnicodeDecodeError, yaml.YAMLError):
            return []


class OpenCodeNamingAdapter(MetadataNamingAdapter):
    def _source_path(self, process: AgenticProcess) -> Path | None:
        from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import opencode_db_path
        return opencode_db_path().resolve()

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        path = self._source_path(process)
        if not path.exists() or not process.session_id:
            return []
        try:
            # Read-only connection sees committed WAL entries; no writes or retry.
            db = sqlite3.connect(path.as_uri() + '?mode=ro', uri=True)
            try:
                row = db.execute('SELECT title, time_updated FROM session WHERE id = ?',
                                 (process.session_id,)).fetchone()
            finally:
                db.close()
        except sqlite3.Error:
            return []
        if not row or not isinstance(row[0], str) or re.fullmatch(r'(?:New|Child) session - \d{4}-\d{2}-\d{2}T.*', row[0]):
            return []
        # The native store has no title-provenance field.
        # OpenCode does not advance time_updated for a manual title-only rename.
        item = _observation(process, row[0], NameOrigin.UNKNOWN, 'opencode.session')
        return [item] if item else []


class DeepAgentsNamingAdapter:
    """The Deep Agents runner keeps no title of its own — a LangGraph thread has none — so
    there is never a native name to observe and no transcript entry can move one. The
    process keeps whatever FlowPad's own first-prompt naming gave it."""

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        return []

    def transcript_may_rename(self, entries: Sequence[object]) -> bool:
        return False
