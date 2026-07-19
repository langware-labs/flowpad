"""Operations on AGENT records — loaders + CLI serializers that used to live
as methods on the deleted ``AgentRecord`` subclass."""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.functions.agent import (
    AGENTS_SPEC_FIELDS,
    JSON_TO_KEY,
    KEY_TO_JSON,
    extract_agent,
    parse_agent_markdown,
)
from flow_sdk.instance_settings import get_instance_settings


def extract_agent_from_path(path: str | Path) -> Record | None:
    """Build a Record from a standalone .md path.

    Replaces ``AgentRecord.from_file``. Returns None if the file can't be read.
    """
    records = extract_agent(FSRef(Path(path)))
    return records[0] if records else None


def load_system_agent(name: str) -> Record | None:
    """Replaces ``AgentRecord.load_system_agent``.

    Lookup order: SDK-bundled agents dir → legacy workspace install. Soft-fail
    on parse error — returns None.
    """
    from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

    agents_dir = flowpad_assistant_project_root() / ".claude" / "agents"
    md = agents_dir / f"{name}.md"
    if md.is_file():
        try:
            return extract_agent_from_path(md)
        except (OSError, ValueError, UnicodeDecodeError) as exc:
            import logging  # noqa: PLC0415
            logging.warning("load_system_agent: failed to parse %s: %s", md, exc)
            return None
    legacy = (
        Path.home()
        / "Flowpad workspace"
        / ".flow"
        / "system_assets"
        / "agents"
        / name
    )
    if legacy.is_dir():
        # Legacy folder layout — find the .md inside and parse.
        md_files = list(legacy.glob("*.md"))
        if md_files:
            return extract_agent_from_path(md_files[0])
    return None


def load_agent(name: str, project_dir: str | Path | None = None) -> Record | None:
    """Replaces ``AgentRecord.load_agent``. Priority: project > user > system."""
    if project_dir is not None:
        p = Path(project_dir) / ".claude" / "agents" / name
        if p.is_dir():
            md_files = list(p.glob("*.md"))
            if md_files:
                return extract_agent_from_path(md_files[0])
        md = Path(project_dir) / ".claude" / "agents" / f"{name}.md"
        if md.is_file():
            return extract_agent_from_path(md)

    user = get_instance_settings().claude_agents_dir / name
    if user.is_dir():
        md_files = list(user.glob("*.md"))
        if md_files:
            return extract_agent_from_path(md_files[0])
    user_md = get_instance_settings().claude_agents_dir / f"{name}.md"
    if user_md.is_file():
        return extract_agent_from_path(user_md)

    return load_system_agent(name)


def agent_to_cli_json(rec: Record) -> dict[str, dict[str, Any]]:
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
        val = rec.data.get(key)
        if val is not None:
            json_key = KEY_TO_JSON.get(key, key)
            entry[json_key] = val
    return {rec.name or rec.id: entry}


def agent_from_cli_json(name: str, data: dict[str, Any]) -> Record:
    """Replaces ``AgentRecord.from_agents_json``."""
    kwargs: dict[str, Any] = {
        "type": RecordType.AGENT,
        "status": "active",
        "id": name,
        "name": name,
    }
    for json_key, val in data.items():
        data_key = JSON_TO_KEY.get(json_key, json_key)
        kwargs[data_key] = val
    return Record(**kwargs)


def render_agent_markdown(rec: Record) -> str:
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


def get_agent(uid: str) -> Record | None:
    """Look up an agent Record by id.

    Replaces ``AgentRecord.get``. Resolution order:
    1. Shadow records root (DB-indexed records).
    2. User agents dir: ``<claude_agents_dir>/<uid>.md``.
    3. System / bundled agents via ``load_system_agent``.
    """
    from flow_sdk.fs_store.record_paths import is_record_dir, shadow_dir_for  # noqa: PLC0415
    import json  # noqa: PLC0415

    folder = shadow_dir_for(RecordType.AGENT, uid)
    if is_record_dir(folder):
        try:
            return FSRecord.load_record(folder)
        except (json.JSONDecodeError, OSError):
            pass

    user_dir = get_instance_settings().claude_agents_dir
    md = user_dir / f"{uid}.md"
    if md.exists():
        return extract_agent_from_path(md)

    return load_system_agent(uid)


def install_agent_md(rec: Record, base_dir: str | Path) -> Path:
    """Write ``base_dir/.claude/agents/<name>.md`` from the record.

    Replaces ``AgentRecord.clone(base_dir)``. Returns the written path.
    """
    md_path = Path(base_dir) / ".claude" / "agents" / f"{rec.name}.md"
    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(render_agent_markdown(rec))
    return md_path
