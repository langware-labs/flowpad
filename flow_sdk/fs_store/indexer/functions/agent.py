"""Extractor + default body for AGENT records.

An Agent is a folder asset at ``agentic-assets/agent/<name>/agent.md``:
YAML frontmatter carries the launch bundle, the markdown body IS the
``system_prompt``. Discovery is the generic ``repo_assets_fn`` walk (gated on
``main_file``) — this module owns only the parse and the render.

The entity owns the file (``owns_main_ref``), so ``agent_default_body``
re-renders frontmatter + body on every save. ``content`` therefore holds the
BODY ONLY: if it still carried the frontmatter, each save would append a
duplicate block — the same round-trip rule ``extract_spec`` documents.
"""
from __future__ import annotations

from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer._frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.fs_store.record_types import RecordType

#: Frontmatter keys that round-trip onto the entity. Mirrors the Agent fields;
#: `name` comes from the folder so a rename can't desync the two.
AGENT_SPEC_FIELDS = (
    "description",
    "avatar",
    "worker_type",
    "model",
    "permission_mode",
    "effort",
    "max_turns",
    "tools",
    "disallowed_tools",
    "skills",
    "mcp_servers",
    "subagents",
    "additional_dirs",
    "load_flowpad_assistant",
    "cli_options",
    "enabled",
)


def parse_agent_markdown(text: str, name: str) -> dict[str, Any]:
    """Pure parse: frontmatter -> fields, body -> system_prompt."""
    fm = _extract_frontmatter(text)
    fields = (_yaml_load(fm) if fm else None) or {}
    out: dict[str, Any] = {"name": fields.get("name") or name}
    for key in AGENT_SPEC_FIELDS:
        if key in fields and fields[key] is not None:
            out[key] = fields[key]
    out["system_prompt"] = (_extract_body(text) or "").strip()
    return out


def extract_agent(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    path = ref._path
    name = path.parent.name
    try:
        text = path.read_text(encoding="utf-8")
    except OSError:
        text = ""
    parsed = parse_agent_markdown(text, name)
    prompt = parsed.pop("system_prompt", "")
    rec = FSRecord(
        type=RecordType.AGENT,
        id=resolved_id,
        asset_ref=ref,
        system_prompt=prompt,
        # mirrored for FTS, like every other prose-bearing asset
        content=prompt,
        **parsed,
    )
    return [rec]


def agent_default_body(entity) -> str:
    """Render frontmatter + system prompt. Called on EVERY save (owns_main_ref)."""
    from flow_sdk.schema.type_info import render_entity_frontmatter  # noqa: PLC0415

    fm: dict[str, Any] = {"name": getattr(entity, "name", None) or "agent"}
    for key in AGENT_SPEC_FIELDS:
        value = getattr(entity, key, None)
        # `None` means "inherit"; an empty list is a real, different statement,
        # so only None is dropped.
        if value is None:
            continue
        if isinstance(value, list):
            value = [str(v) for v in value]
        fm[key] = value
    body = (getattr(entity, "system_prompt", "") or "").strip()
    return render_entity_frontmatter(entity, fm) + f"\n\n{body}\n"
