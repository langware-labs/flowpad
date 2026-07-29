"""Agent entity — graph/HTTP surface for FSRecord(type='agent').

On-disk parsing lives in ``fs_store/indexer/functions/agent.py`` and is wired
to the indexer via ``TypeInfo`` callable slots, not classmethods here.
"""
from __future__ import annotations

from typing import ClassVar, TYPE_CHECKING

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core import action
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.flowpad_types.enums import AgentKind

if TYPE_CHECKING:
    from flow_sdk.responses.response import ApiResponse


class Agent(Entity):
    """Filesystem-backed agent entity. Source: ``<scope>/.claude/agents/<name>.md``."""

    type: str = APIField(default=BuiltinEntityType.AGENT.value)
    name: str | None = APIField(default=None)
    description: str | None = APIField(default=None)
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    # How the agent is used. HARNESS (default) = a normal sub-agent; VIBE = a
    # vibe persona layered on top of the standard vibe agent (embedded after it
    # on vibe process start). Sourced from the `.claude/agents/*.md` frontmatter
    # `kind:` key (see AGENTS_SPEC_FIELDS).
    kind: AgentKind = APIField(default=AgentKind.HARNESS)

    @action.post(action_name="set-kind")
    async def set_kind_action(self, kind: str = "") -> "ApiResponse":
        """Set this agent's ``kind`` frontmatter (mark/unmark as a vibe agent),
        preserving every OTHER frontmatter field, then reindex so queries and
        the entity reflect it. The full-frontmatter re-render is why this is a
        backend action, not a client-side FrontMatterFsRef.save (which drops
        non-name/description fields).
        """
        from pathlib import Path  # noqa: PLC0415

        from flow_sdk.fs_store.operations.agent import (  # noqa: PLC0415
            extract_agent_from_path,
            render_agent_markdown,
        )
        from flow_sdk.fs_store.reindex import reindex_paths  # noqa: PLC0415
        from flow_sdk.responses.response import ApiFailResponse, ApiSuccessResponse  # noqa: PLC0415

        try:
            kind_val = AgentKind(kind)
        except ValueError:
            return ApiFailResponse(message=f"invalid kind: {kind!r}")
        ref = self.asset_ref or ""
        path = Path("/" + ref.lstrip("/")) if ref else None
        if path is None or not path.exists():
            return ApiFailResponse(message="agent source file not found", status_code=404)
        rec = extract_agent_from_path(path)
        if rec is None:
            return ApiFailResponse(message="could not parse agent file")
        # ``rec.data`` is a read-only view (meta_dict); fields live on __dict__.
        rec.__dict__["kind"] = kind_val.value
        path.write_text(render_agent_markdown(rec), encoding="utf-8")
        await reindex_paths([str(path)])
        return ApiSuccessResponse(data={"id": self.id, "kind": kind_val.value})
