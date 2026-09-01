"""SubAgent entity — graph/HTTP surface for FSRecord(type='subagent').

On-disk parsing lives in ``fs_store/indexer/functions/agent.py`` and is wired
to the indexer via ``TypeInfo`` callable slots, not classmethods here.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums import SubAgentKind
from flow_sdk.fs_store.serializer.fields import FieldKind, field_kinds
from flow_sdk.schema.data_spec import Body, FrontMatter

if TYPE_CHECKING:
    from flow_sdk.responses.response import ApiResponse


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


class SubAgent(Entity):
    """A ``.claude/agents/<name>.md`` file — the ROW. Its shape on disk is
    ``SubAgentSpec`` (``TypeInfo.asset_spec``); identity is a capsule.
    """

    type: str = APIField(default=BuiltinEntityType.SUBAGENT.value)
    name: str | None = APIField(default=None)
    description: str | None = APIField(default=None)
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    # How the sub-agent is used. HARNESS (default) = a normal sub-agent; VIBE =
    # a vibe persona layered on top of the standard vibe sub-agent (embedded
    # after it on vibe process start). A frontmatter key, but flowpad's — it
    # never reaches the Claude ``--agents`` JSON.
    kind: SubAgentKind = APIField(default=SubAgentKind.HARNESS)
    # The body — the sub-agent's system prompt.
    prompt: str = APIField(default="")
    # Claude's ``--agents`` spec keys, round-tripped verbatim through frontmatter.
    tools: Any = APIField(default=None)
    disallowed_tools: Any = APIField(default=None)
    model: Optional[str] = APIField(default=None)
    color: Optional[str] = APIField(default=None)
    permission_mode: Optional[str] = APIField(default=None)
    max_turns: Optional[int] = APIField(default=None)
    skills: Any = APIField(default=None)
    mcp_servers: Any = APIField(default=None)
    hooks: Any = APIField(default=None)
    memory: Any = APIField(default=None)
    background: Any = APIField(default=None)
    isolation: Any = APIField(default=None)

    @action.post(action_name="set-kind")
    async def set_kind_action(self, kind: str = "") -> "ApiResponse":
        """Set this sub-agent's ``kind`` frontmatter (mark/unmark as a vibe sub-agent),
        preserving every OTHER frontmatter field, then reindex so queries and
        the entity reflect it. ``from_fs`` → ``to_fs`` is what preserves the
        rest: the class declares the whole header, so nothing is dropped.
        """
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            kind_val = SubAgentKind(kind)
        except ValueError:
            return ApiFailResponse(message=f"invalid kind: {kind!r}")
        ref = self.asset_ref or ""
        # `Path(ref).resolve()` — FSRef's own construction. Rooting it with
        # `Path("/" + ref)` corrupted Windows refs (`C:\...` → `\C:\...`).
        path = Path(ref).resolve() if ref else None
        if path is None or not path.exists():
            return ApiFailResponse(message="agent source file not found", status_code=404)
        from flow_sdk.fs_store.origin.local_origin import local_origin_for_path  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        ser = SchemaRegistry.get(self.get_type()).serializer()
        origin = local_origin_for_path(path)
        on_disk = ser.load(SubAgent, origin)
        on_disk.kind = kind_val
        ser.store(on_disk, origin, force=True)   # an explicit file edit: rewrite even though the type is unowned
        await reindex_paths([str(path)])
        return ApiSuccessResponse(data={"id": self.id, "kind": kind_val.value})
