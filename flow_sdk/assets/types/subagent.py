"""Read-only subagent files, filesystem records, and provider serialization."""

from __future__ import annotations

import json
import logging
import uuid
from pathlib import Path
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.assets.frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.assets.types.subagent_spec import AGENTS_SPEC_FIELDS, KEY_TO_JSON, SubAgentSpec
from flow_sdk.capsules.errors import CapsuleError
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.identity_carrier import Found, Frontmatter
from flow_sdk.fs_store.record_types import RecordType

logger = logging.getLogger(__name__)


def extract_subagent_from_path(path: str | Path) -> FSRecord | None:
    """Build a Record from a standalone .md path.

    Replaces ``AgentRecord.from_file``. Returns None if the file can't be read.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(str(RecordType.SUBAGENT))
    if info is None:
        raise ValueError("SubAgent type is not registered")
    ref = FSRef(Path(path), record_type=RecordType.SUBAGENT, read_only=True)
    return info.record_for(ref, info.read_identity(info.layout_for(ref), ref=ref))


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


def load_subagent(name: str, roots: list[Path]) -> FSRecord | None:
    """Read the first matching subagent from caller-ordered asset roots."""
    return _first([candidate for root in roots for candidate in (Path(root) / name, Path(root) / f"{name}.md")])


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
    from flow_sdk.assets.frontmatter import _render_frontmatter  # noqa: PLC0415

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
    """Read a subagent filesystem record by identity; no scope fallback."""
    try:
        return FSRecord.load(RecordType.SUBAGENT, uid)
    except (json.JSONDecodeError, OSError):
        return None


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

    header = SubAgentSpec.model_validate(fields)
    agent_name = name or header.name or "unnamed"
    rec_id = raw_id.strip() if isinstance(raw_id, str) and raw_id.strip() else agent_name

    data: dict[str, Any] = {"id": rec_id, "name": agent_name}
    data.update(header.model_dump(exclude_none=True, exclude={"name"}))
    if body:
        data["prompt"] = body
    return data
