"""Extractor + helpers for AGENT records.

An agent is a flat ``.md`` file under ``<root>/<harness-dot-dir>/agents/`` — most
often ``.claude/agents/``, but the type is ``asset_class="shared"``, so placement
writes it under whichever dot-dir the machine's harness declares (``.agents`` for
codex, ``.github`` for copilot). Discovery is the type's declared ``walk``
(``subagent_type_info.py``), whose mounts derive from that same placement, so
the read side agrees with wherever a copy may be written. YAML frontmatter
carries the ``--agents`` CLI spec; the markdown body is the system prompt.

Replaces the parse/extract behaviour of the deleted ``AgentRecord`` subclass.
Operations (``load_subagent``, ``load_system_subagent``, ``subagent_to_cli_json``,
markdown rendering) live in ``flow_sdk/fs_store/operations/agent.py``.

Public helpers used outside the indexer:
  - ``parse_subagent_markdown(text, name)`` — pure frontmatter+body parse
  - ``extract_subagent(ref, resolved_id)`` — parser_fn entry
  - ``agent_id(ref)`` — compatibility read helper
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.fs_store.identity_carrier import Found, Frontmatter
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.record_types import RecordType

# Mapping from snake_case _data keys to camelCase --agents JSON keys
KEY_TO_JSON = {
    "disallowed_tools": "disallowedTools",
    "permission_mode": "permissionMode",
    "max_turns": "maxTurns",
    "mcp_servers": "mcpServers",
}


# ── id helpers ───────────────────────────────────────────────────────────────


def _read_frontmatter_id(path: Path) -> str | None:
    """The valid frontmatter ``id:``, or None — the carrier's own read."""
    found = Frontmatter().read(path)
    return found.id if isinstance(found, Found) else None


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
    """Cheap id: frontmatter ``id``; else frontmatter ``name``; else filename stem."""
    existing = _read_frontmatter_id(ref._path)
    if existing:
        return existing
    name = _read_frontmatter_name(ref._path)
    if name:
        return name
    return ref._path.stem


def subagent_peek_entity_id(ref: FSRef) -> str:
    """Entity UUID for an agent .md without writing the source.

    Strictly read-only, so it is safe to call from request handlers — hence the
    probe form of the seam (``derive=False, overwrite=False``), which never
    stamps a missing capsule onto a read-only mount.

    Carrier reads go through the type's carrier (``read_id``). The miss path does NOT:
    it derives ``uuid5(DNS, "subagent:<name-or-stem>")`` while the seam would
    derive ``uuid5(URL, <resolved path>)``. **These disagree**, and the value is
    kept as-is deliberately — converging it would move the id of every
    unstamped subagent, which is a data migration, not a refactor. Verified
    divergent rather than assumed; see the id-derivation golden file.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.SUBAGENT))
    if info is not None:
        existing = info.read_id(ref)
        if existing is not None:
            return existing
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        key = ref._path.stem
    else:
        fm = _extract_frontmatter(text)
        fields = (_yaml_load(fm) if fm else None) or {}
        from flow_sdk.api.api_types.identifier import adopt_entity_id  # noqa: PLC0415

        adopted = adopt_entity_id(fields.get("id"))
        if adopted:
            return adopted
        name = fields.get("name")
        key = name.strip() if isinstance(name, str) and name.strip() else ref._path.stem
    return mint_uuid(f"{RecordType.SUBAGENT}:{key}", namespace=uuid.NAMESPACE_DNS)



# ── Parse + extract ──────────────────────────────────────────────────────────


def parse_subagent_markdown(text: str, name: str | None = None) -> dict[str, Any]:
    """Parse frontmatter + body into a fields dict: id/name/spec fields + ``prompt``.

    The field set is ``SubAgentSpec`` — the parser no longer keeps its own
    list. Used by the indexer extractor and every record-shaped caller.
    """
    from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

    text = strip_capsule_blocks(text)
    fm_text = _extract_frontmatter(text)
    fields = _yaml_load(fm_text) if fm_text else {}
    body = _extract_body(text)

    raw_id = fields.pop("id", None)
    from flow_sdk.builtin.subagent import SubAgentSpec  # noqa: PLC0415

    header = SubAgentSpec.model_validate(fields)
    agent_name = name or header.name or "unnamed"
    rec_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else agent_name

    data: dict[str, Any] = {"id": rec_id, "name": agent_name}
    data.update(header.model_dump(exclude_none=True, exclude={"name"}))
    if body:
        data["prompt"] = body
    return data
