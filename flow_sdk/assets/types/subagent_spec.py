"""Claude subagent file schema and CLI field names."""

from __future__ import annotations

from typing import Any

from flow_sdk.fs_store.serializer.fields import FieldKind, field_kinds
from flow_sdk.schema.data_spec import Body, FrontMatter


class SubAgentSpec(FrontMatter):
    """The ``.claude/agents/<name>.md`` document — Claude Code's own schema,
    snake_case as Claude reads it. This class IS the field list: what it
    declares is what is read and written, and nothing else. ``prompt`` is the
    markdown ``Body``.

    ``kind`` is flowpad's, not Claude's (excluded from the ``--agents`` CLI
    JSON by ``subagent_to_cli_json``); it still rides the frontmatter.
    """

    name: str | None = None
    description: str | None = None
    kind: str | None = None
    tools: Any = None
    disallowed_tools: Any = None
    model: str | None = None
    color: str | None = None
    permission_mode: str | None = None
    max_turns: int | None = None
    skills: Any = None
    mcp_servers: Any = None
    hooks: Any = None
    memory: Any = None
    background: Any = None
    isolation: Any = None
    prompt: Body = ""


#: The Claude ``--agents`` spec keys — every header scalar except ``name``
#: (the Body is the prompt; the name is the file).
AGENTS_SPEC_FIELDS = tuple(n for n, k in field_kinds(SubAgentSpec) if k is FieldKind.SCALAR and n != "name")


KEY_TO_JSON = {
    "disallowed_tools": "disallowedTools",
    "permission_mode": "permissionMode",
    "max_turns": "maxTurns",
    "mcp_servers": "mcpServers",
}
