"""Walker + extractor + helpers for AGENT records.

An agent is a flat ``.md`` file under ``<root>/.claude/agents/`` (or a folder
of the same shape for legacy installs). YAML frontmatter carries the
``--agents`` CLI spec; the markdown body is the system prompt.

Replaces the parse/extract behaviour of the deleted ``AgentRecord`` subclass.
Operations (``load_agent``, ``load_system_agent``, ``agent_to_cli_json``,
markdown rendering) live in ``flow_sdk/fs_store/operations/agent.py``.

Public helpers used outside the indexer:
  - ``parse_agent_markdown(text, name)`` — pure frontmatter+body parse
  - ``extract_agent(ref)`` — parser_fn entry
  - ``agent_id(ref)`` / ``agent_gen_id(ref)`` — id helpers
  - ``AGENTS_SPEC_FIELDS`` / ``KEY_TO_JSON`` / ``JSON_TO_KEY`` — spec mapping
"""

from __future__ import annotations

from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


# Fields stored in _data that map to the Claude Code --agents JSON spec
AGENTS_SPEC_FIELDS = (
    "description",
    "tools",
    "disallowed_tools",
    "model",
    "color",
    "permission_mode",
    "max_turns",
    "skills",
    "mcp_servers",
    "hooks",
    "memory",
    "background",
    "isolation",
)

# Mapping from snake_case _data keys to camelCase --agents JSON keys
KEY_TO_JSON = {
    "disallowed_tools": "disallowedTools",
    "permission_mode": "permissionMode",
    "max_turns": "maxTurns",
    "mcp_servers": "mcpServers",
}
JSON_TO_KEY = {v: k for k, v in KEY_TO_JSON.items()}


# ── Walker ───────────────────────────────────────────────────────────────────


def agent_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        agents = Path(node.path) / ".claude" / "agents"
        if not agents.is_dir():
            continue
        for md in sorted(agents.glob("*.md")):
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(FSRef(md, record_type=RecordType.AGENT, parent=node))
    return out


# ── id helpers ───────────────────────────────────────────────────────────────


def _read_frontmatter_id(path: Path) -> str | None:
    """Return frontmatter `id` (or legacy `asset_id`), or None."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    raw = fields.get("id") or fields.get("asset_id")
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    return adopt_entity_id(raw)  # validate-on-adopt (v4/v5) → else caller derives


def _read_frontmatter_name(path: Path) -> str | None:
    """Return frontmatter `name`, or None."""
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return None
    fm = _extract_frontmatter(text)
    if not fm:
        return None
    fields = _yaml_load(fm) or {}
    name = fields.get("name")
    return str(name).strip() if isinstance(name, str) and name.strip() else None


def agent_id(ref: FSRef) -> str:
    """Cheap id: frontmatter `id` (or `asset_id`); else frontmatter `name`;
    else filename stem."""
    existing = _read_frontmatter_id(ref._path)
    if existing:
        return existing
    name = _read_frontmatter_name(ref._path)
    if name:
        return name
    return ref._path.stem


def agent_gen_id(ref: FSRef) -> str:
    """Mint+write id into agent .md frontmatter (idempotent).

    Same shape as the deleted ``AgentRecord.genId``. Preserves the derived id
    (frontmatter name or filename stem) so DB rows keyed by that value stay
    valid.
    """
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        return agent_id(ref)
    fm = _extract_frontmatter(text)
    fields: dict = {}
    if fm:
        parsed = _yaml_load(fm)
        if isinstance(parsed, dict):
            fields.update(parsed)
    from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415
    adopted = adopt_entity_id(fields.get("id") or fields.get("asset_id"))
    if adopted:  # validate-on-adopt — same gate as the read path
        return adopted
    name = fields.get("name")
    if isinstance(name, str) and name.strip():
        new_id = name.strip()
    else:
        new_id = ref._path.stem
    body = _extract_body(text)
    merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
    try:
        ref._path.write_text(
            _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
            encoding="utf-8",
        )
    except OSError:
        pass
    return new_id


# ── Parse + extract ──────────────────────────────────────────────────────────


def parse_agent_markdown(text: str, name: str | None = None) -> dict[str, Any]:
    """Parse YAML frontmatter + markdown body into a fields dict.

    Returns id/name/spec fields + 'prompt' (the body). Used by both the
    indexer extractor and ``operations/agent.py`` helpers.
    """
    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    body = _extract_body(text)

    agent_name = name or fields.pop("name", None) or "unnamed"
    raw_id = fields.pop("id", None) or fields.pop("asset_id", None)
    rec_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else agent_name

    data: dict[str, Any] = {"id": rec_id, "name": agent_name}
    for key in AGENTS_SPEC_FIELDS:
        if key in fields:
            data[key] = fields[key]
    if body:
        data["prompt"] = body
    return data


def extract_agent(ref: FSRef) -> list[FSRecord]:
    """Parse an agent .md into a Record. Replaces ``AgentRecord._from_fsref_sync``.

    Eagerly populates: id, name, description, prompt, content (for FTS body =
    name + description + prompt), spec fields. Sets _asset_ref to a
    FrontMatterFsRef on the source .md so callers that need the FM API can
    read/write it.
    """
    path = ref._path
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        return []
    data = parse_agent_markdown(text, name=path.stem)
    data["type"] = RecordType.AGENT
    data["status"] = "active"
    # prompt is stored under 'prompt_text' on the shim subclass; for parser_fn-
    # built generic Records, we store it under both 'prompt' and 'prompt_text'
    # so search_content + AGENT-aware callers both see it.
    prompt = data.pop("prompt", None)
    if prompt:
        data["prompt_text"] = prompt
    # Composite FTS body: name + description + prompt body.
    parts: list[str] = []
    if data.get("name"):
        parts.append(str(data["name"]))
    desc = data.get("description")
    if desc:
        parts.append(str(desc))
    if prompt:
        parts.append(prompt)
    data["content"] = "\n".join(parts) if parts else ""
    data["body"] = prompt or ""

    rec = FSRecord(**data)
    from flow_sdk.fs_store.fs_ref import FrontMatterFsRef  # noqa: PLC0415
    object.__setattr__(rec, "_asset_ref", FrontMatterFsRef(path))
    return [rec]
