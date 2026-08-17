"""Walker + extractor + helpers for AGENT records.

An agent is a flat ``.md`` file under ``<root>/<harness-dot-dir>/agents/`` — most
often ``.claude/agents/``, but the type is ``asset_class="shared"``, so placement
writes it under whichever dot-dir the machine's harness declares (``.agents`` for
codex, ``.github`` for copilot). The walker scans all of them. YAML frontmatter
carries the ``--agents`` CLI spec; the markdown body is the system prompt.

Replaces the parse/extract behaviour of the deleted ``AgentRecord`` subclass.
Operations (``load_subagent``, ``load_system_subagent``, ``subagent_to_cli_json``,
markdown rendering) live in ``flow_sdk/fs_store/operations/agent.py``.

Public helpers used outside the indexer:
  - ``parse_subagent_markdown(text, name)`` — pure frontmatter+body parse
  - ``extract_subagent(ref, resolved_id)`` — parser_fn entry
  - ``agent_id(ref)`` — compatibility read helper
  - ``AGENTS_SPEC_FIELDS`` / ``KEY_TO_JSON`` / ``JSON_TO_KEY`` — spec mapping
"""

from __future__ import annotations

import uuid
from pathlib import Path
from typing import Any

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identifier import mint_uuid
from flow_sdk.fs_store.indexer._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _yaml_load,
)
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType

# Fields stored in _data that map to the Claude Code --agents JSON spec
AGENTS_SPEC_FIELDS = (
    "description",
    "kind",
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


def subagent_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    """Discover agent ``.md`` files under EVERY harness dot-dir, not just ``.claude``.

    AGENT is ``asset_class="shared"``, so ``family_subdir`` picks the dot-dir from
    the machine's ``default_worker`` (``placement.effective_harness``): the entity
    save path writes a codex-default machine's agents to ``.agents/agents/``. A
    walker that only scanned ``.claude/agents`` therefore never indexed them —
    written, then invisible. Scanning the whole ``WORKER_PREFIX`` set keeps the
    read side in agreement with wherever placement is allowed to write.
    """
    from flow_sdk.fs_store.placement import WORKER_PREFIX  # noqa: PLC0415

    # dict values repeat (github/copilot both map to ``.github``); dedupe and
    # order them so discovery is deterministic across machines.
    prefixes = sorted(set(WORKER_PREFIX.values()))
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        for prefix in prefixes:
            agents = Path(node.path) / prefix / "agents"
            if not agents.is_dir():
                continue
            for md in sorted(agents.glob("*.md")):
                key = str(md.resolve())
                if key in seen:
                    continue
                seen.add(key)
                out.append(FSRef(md, record_type=RecordType.SUBAGENT, parent=node))
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


def subagent_peek_entity_id(ref: FSRef) -> str:
    """Entity UUID for an agent .md without writing the source.

    Strictly read-only, so it is safe to call from request handlers — hence the
    probe form of the seam (``derive=False, overwrite=False``), which never
    stamps a missing capsule onto a read-only mount.

    Carrier reads go through ``TypeInfo.mint_entity_id``. The miss path does NOT:
    it derives ``uuid5(DNS, "subagent:<name-or-stem>")`` while the seam would
    derive ``uuid5(URL, <resolved path>)``. **These disagree**, and the value is
    kept as-is deliberately — converging it would move the id of every
    unstamped subagent, which is a data migration, not a refactor. Verified
    divergent rather than assumed; see the id-derivation golden file.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.SUBAGENT))
    if info is not None:
        existing = info.mint_entity_id(ref)
        if existing is not None:
            return existing
    try:
        text = ref._path.read_text(encoding="utf-8")
    except OSError:
        key = ref._path.stem
    else:
        fm = _extract_frontmatter(text)
        fields = (_yaml_load(fm) if fm else None) or {}
        from flow_sdk.fs_store.identifier import adopt_entity_id  # noqa: PLC0415

        adopted = adopt_entity_id(fields.get("id") or fields.get("asset_id"))
        if adopted:
            return adopted
        name = fields.get("name")
        key = name.strip() if isinstance(name, str) and name.strip() else ref._path.stem
    return mint_uuid(f"{RecordType.SUBAGENT}:{key}", namespace=uuid.NAMESPACE_DNS)



# ── Parse + extract ──────────────────────────────────────────────────────────


def parse_subagent_markdown(text: str, name: str | None = None) -> dict[str, Any]:
    """Parse YAML frontmatter + markdown body into a fields dict.

    Returns id/name/spec fields + 'prompt' (the body). Used by both the
    indexer extractor and ``operations/agent.py`` helpers.
    """
    from flow_sdk.capsules import strip_capsule_blocks  # noqa: PLC0415

    text = strip_capsule_blocks(text)
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


def extract_subagent(ref: FSRef, resolved_id: str) -> list[FSRecord]:
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
    data = parse_subagent_markdown(text, name=path.stem)
    data["id"] = resolved_id
    data["type"] = RecordType.SUBAGENT
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
