"""Provider title observations. Priority and persistence belong to the shared FSM."""
from __future__ import annotations

import hashlib
import re
import sqlite3
import unicodedata
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
    def watch_paths(self, process: AgenticProcess) -> tuple[Path, ...]: ...
    def terminal_observation(self, process: AgenticProcess, title: str) -> NameObservation | None: ...


def _observation(process: AgenticProcess, title: object, origin: NameOrigin, source: str,
                 sequence: int | None = None, revision: str | None = None) -> NameObservation | None:
    if not process.session_id or not isinstance(title, str) or not title.strip():
        return None
    return NameObservation(title=title, origin=origin, source=source,
                           session_id=process.session_id, sequence=sequence,
                           revision=revision or hashlib.sha256(f'{sequence}:{title}'.encode()).hexdigest())


class MetadataNamingAdapter:
    """No terminal title is trusted unless a provider explicitly implements it."""
    def terminal_observation(self, process: AgenticProcess, title: str) -> NameObservation | None:
        return None


class ClaudeNamingAdapter(MetadataNamingAdapter):
    def watch_paths(self, process: AgenticProcess) -> tuple[Path, ...]:
        path = getattr(process, "transcript_path", None)
        return (Path(path).resolve(),) if path else ()

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        from flow_sdk.assets.types.claude_titles import read_claude_title
        paths = self.watch_paths(process)
        title = read_claude_title(paths[0]) if paths else None
        if title is None:
            return []
        item = _observation(process, title.title,
                            NameOrigin.EXPLICIT_USER if title.explicit else NameOrigin.HARNESS_AUTO,
                            'claude.metadata', title.sequence, title.revision)
        return [item] if item else []

    def terminal_observation(self, process: AgenticProcess, title: str) -> NameObservation | None:
        # Prefer the durable native metadata, including its manual-name marker.
        metadata = self.read(process)
        if metadata:
            return metadata[0]
        cleaned = re.sub(r'\x1b\[[0-9;?]*[ -/]*[@-~]', '', title)
        cleaned = ''.join(c for c in cleaned if unicodedata.category(c) not in ('Cc', 'So', 'Sk')
                          and not ('\u2190' <= c <= '\u21ff')
                          and not ('\u2500' <= c <= '\u28ff') and c != '\ufe0f')
        cleaned = ' '.join(cleaned.split())
        if not any(c.isalpha() for c in cleaned) or 'claude code' in cleaned.lower():
            return None
        if cleaned.lower() in ('claude', 'claude.exe') or re.match(r'^(?:[a-z]:[\\/]|\\\\).*\.exe$', cleaned, re.I):
            return None
        if re.fullmatch(r'[a-z][a-z0-9_-]*-[0-9a-f]{8}-[0-9a-f]{4}-[45][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}', cleaned, re.I):
            return None
        # OSC has no manual/automatic bit. Preserve that uncertainty instead of
        # silently allowing a later automatic title to undo a manual CLI rename.
        return _observation(process, cleaned, NameOrigin.UNKNOWN, 'claude.terminal')


class CodexNamingAdapter(MetadataNamingAdapter):
    def watch_paths(self, process: AgenticProcess) -> tuple[Path, ...]:
        from flow_sdk.instance_settings import get_instance_settings
        return ((get_instance_settings().codex_session_index_path).resolve(),)

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        from flow_sdk.assets.types.codex_titles import read_codex_title

        title = read_codex_title(self.watch_paths(process)[0], process.session_id)
        if title is None:
            return []
        # Codex persists exactly the same record for automatic and manual titles.
        item = _observation(process, title.title, NameOrigin.UNKNOWN,
                            'codex.session_index', title.sequence, title.revision)
        return [item] if item else []


class CopilotNamingAdapter(MetadataNamingAdapter):
    def watch_paths(self, process: AgenticProcess) -> tuple[Path, ...]:
        from flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history import copilot_session_state_root
        return ((copilot_session_state_root() / process.session_id / 'workspace.yaml').resolve(),) if process.session_id else ()

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        paths = self.watch_paths(process)
        if not paths:
            return []
        try:
            raw = yaml.safe_load(paths[0].read_text(encoding='utf-8'))
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
            item = _observation(process, title, origin, 'copilot.workspace', _timestamp_ns(raw.get('updated_at')) or paths[0].stat().st_mtime_ns)
            return [item] if item else []
        except (OSError, UnicodeDecodeError, yaml.YAMLError):
            return []


class OpenCodeNamingAdapter(MetadataNamingAdapter):
    def watch_paths(self, process: AgenticProcess) -> tuple[Path, ...]:
        from flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history import opencode_db_path
        path = opencode_db_path().resolve()
        return (path, Path(str(path) + '-wal'))

    def read(self, process: AgenticProcess) -> list[NameObservation]:
        path = self.watch_paths(process)[0]
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
