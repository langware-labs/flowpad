"""Operations on AGENT records — loaders + CLI serializers that used to live
as methods on the deleted ``AgentRecord`` subclass."""

from __future__ import annotations

import logging
from pathlib import Path
from typing import Any

from flow_sdk.builtin.subagent import AGENTS_SPEC_FIELDS
from flow_sdk.capsules.errors import CapsuleError
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.subagent import (
    KEY_TO_JSON,
)
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.instance_settings import get_instance_settings

logger = logging.getLogger(__name__)


def extract_subagent_from_path(path: str | Path) -> FSRecord | None:
    """Build a Record from a standalone .md path.

    Replaces ``AgentRecord.from_file``. Returns None if the file can't be read.
    """
    from flow_sdk.fs_store.indexer.reconcile import reconcile  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.SUBAGENT))
    ref = FSRef(Path(path), record_type=RecordType.SUBAGENT)
    return info.record_for(ref, reconcile(info, info.layout_for(ref), None, None, write=True, ref=ref))


def _md(candidate: Path) -> Path | None:
    """The one probe every loader shares: a file is itself; a folder is its
    first ``*.md``; anything else is not a sub-agent."""
    if candidate.is_file():
        return candidate
    if candidate.is_dir():
        return min(candidate.glob("*.md"), default=None)
    return None


def _load(candidate: Path) -> FSRecord | None:
    """Parse the sub-agent at ``candidate`` (folder or file); None when absent or unreadable."""
    md = _md(candidate)
    if md is None:
        return None
    try:
        return extract_subagent_from_path(md)
    except (OSError, ValueError, UnicodeDecodeError, CapsuleError) as exc:
        logger.warning("subagent: failed to parse %s: %s", md, exc)
        return None


def _first(candidates: "list[Path]") -> FSRecord | None:
    for candidate in candidates:
        rec = _load(candidate)
        if rec is not None:
            return rec
    return None


def load_system_subagent(name: str) -> FSRecord | None:
    """SDK-bundled ``.claude/agents/<name>.md`` → legacy workspace folder. Soft-fail."""
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    return _first([
        flowpad_assistant_project_root() / ".claude" / "agents" / f"{name}.md",
        Path.home() / "Flowpad workspace" / ".flow" / "system_assets" / "agents" / name,
    ])


def load_subagent(name: str, project_dir: str | Path | None = None) -> FSRecord | None:
    """Priority: project (folder, then file) > user (folder, then file) > system."""
    bases = [get_instance_settings().claude_agents_dir]
    if project_dir is not None:
        bases.insert(0, Path(project_dir) / ".claude" / "agents")
    candidates = [cand for base in bases for cand in (base / name, base / f"{name}.md")]   # folder, then file
    return _first(candidates) or load_system_subagent(name)


def subagent_to_cli_json(rec: FSRecord) -> dict[str, dict[str, Any]]:
    """Build ``{name: {prompt, description, ...}}`` dict for the ``--agents``
    CLI flag. Replaces ``AgentRecord.to_agents_cli_json``.
    """
    entry: dict[str, Any] = {}
    prompt = (
        rec.data.get("prompt")
        or rec.data.get("prompt_text")
        or getattr(rec, "prompt_text", None)
        or ""
    )
    if prompt:
        entry["prompt"] = prompt
    for key in AGENTS_SPEC_FIELDS:
        # ``kind`` is Flowpad routing metadata, not Claude's agent schema (it
        # still round-trips through frontmatter via ``render_subagent_markdown``).
        if key == "kind":
            continue
        val = rec.data.get(key)
        if val is not None:
            json_key = KEY_TO_JSON.get(key, key)
            entry[json_key] = val
    return {rec.name or rec.id: entry}



def render_subagent_markdown(rec: FSRecord) -> str:
    """Render an Agent Record back into markdown (frontmatter + prompt body).

    Replaces ``AgentRecord.to_markdown`` / ``_render_markdown``.
    """
    from flow_sdk.fs_store.indexer._frontmatter import _render_frontmatter  # noqa: PLC0415

    fields: dict[str, Any] = {}
    if rec.name:
        fields["name"] = rec.name
    for key in AGENTS_SPEC_FIELDS:
        val = rec.data.get(key)
        if val is not None:
            fields[key] = val
    fm = _render_frontmatter(fields)
    body = (
        rec.data.get("prompt")
        or rec.data.get("prompt_text")
        or getattr(rec, "prompt_text", None)
        or ""
    )
    if body:
        return f"{fm}\n\n{body}\n"
    return f"{fm}\n"


def get_subagent(uid: str) -> FSRecord | None:
    """Look up an agent Record by id.

    Replaces ``AgentRecord.get``. Resolution order:
    1. Shadow records root (DB-indexed records).
    2. User agents dir: ``<claude_agents_dir>/<uid>.md``.
    3. System / bundled agents via ``load_system_subagent``.
    """
    import json  # noqa: PLC0415

    from flow_sdk.fs_store.record_paths import is_record_dir, shadow_dir_for  # noqa: PLC0415

    folder = shadow_dir_for(RecordType.SUBAGENT, uid)
    if is_record_dir(folder):
        try:
            return FSRecord.load_record(folder)
        except (json.JSONDecodeError, OSError):
            pass

    return _load(get_instance_settings().claude_agents_dir / f"{uid}.md") or load_system_subagent(uid)
