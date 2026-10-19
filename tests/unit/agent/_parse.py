"""Test helper: an ``agent.json`` TEXT (+ its ``system_prompt.md`` body) → fields,
through the same ``AgentSpec`` the serializer reads; ``render`` is the serializer's own."""
from __future__ import annotations

import json
from typing import Any

from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.schema.data_spec.agent_spec import AgentSpec


def parse_agent_document(text: str, name: str, body: str = "") -> dict[str, Any]:
    doc = json.loads(text)
    fields = {key: value for key, value in doc.items() if key not in ("type", "id", "version")}
    out: dict[str, Any] = {"name": fields.get("name") or name}
    out.update(AgentSpec.model_validate(fields).model_dump(mode="json", exclude_none=True, exclude={"system_prompt"}))
    out["system_prompt"] = body.strip()
    return out


def agent_default_body(entity) -> str:
    """The rendered ``agent.json`` text — the prompt is its own file, not in here."""
    return SchemaRegistry.get("agent").serializer().render(entity)
