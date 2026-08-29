"""Test helper: an ``agent.md`` TEXT → fields, through the same ``AgentSpec``
the serializer reads; ``render`` is the serializer's own."""
from __future__ import annotations

from typing import Any

from flow_sdk.builtin.agent import AgentSpec
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def parse_agent_markdown(text: str, name: str) -> dict[str, Any]:
    from flow_sdk.capsules import strip_capsule_blocks
    from flow_sdk.fs_store.indexer._frontmatter import _extract_body, _extract_frontmatter, _yaml_load

    fm = _extract_frontmatter(text)
    fields = (_yaml_load(fm) if fm else None) or {}
    out: dict[str, Any] = {"name": fields.get("name") or name}
    out.update(AgentSpec.model_validate(fields).model_dump(mode="json", exclude_none=True, exclude={"system_prompt"}))
    out["system_prompt"] = strip_capsule_blocks(_extract_body(text) or "").strip()
    return out


def agent_default_body(entity) -> str:
    return SchemaRegistry.get("agent").serializer().render(entity)
