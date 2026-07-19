"""Type metadata for AGENT_TRACE."""
import json
from typing import Optional

from flow_sdk.schema.type_info import TypeMetadata
from flow_sdk.schema.type_info.base_meta import BaseMeta
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode
from flow_sdk.fs_store.indexer.functions.agent_trace import (
    agent_trace_gen_id,
    extract_agent_trace,
)


class AgentTraceMeta(BaseMeta):
    session_id: Optional[str] = None
    worker_type: Optional[str] = None
    verdict: Optional[str] = None
    verdict_reason: Optional[str] = None
    duration_ms: Optional[int] = None
    cost_usd: Optional[float] = None
    issue_count: Optional[int] = None
    divergence_count: Optional[int] = None
    lane_count: Optional[int] = None


def _agent_trace_default_body(entity) -> Optional[str]:
    """trace.json content — the full trace payload carried on create.

    Returns None when the entity holds no payload (metadata-only saves), so
    ``upsert_main_ref`` no-ops and never clobbers the on-disk trace even
    though ``owns_main_ref`` is True.
    """
    trace = getattr(entity, "trace", None)
    if isinstance(trace, str):
        try:
            trace = json.loads(trace)
        except ValueError:
            return None
    if not isinstance(trace, dict) or not trace:
        return None
    # The file is the source of truth the indexer reads the id back from.
    trace = {**trace, "id": entity.id, "name": getattr(entity, "name", "") or trace.get("name", "")}
    return json.dumps(trace, indent=2) + "\n"


AGENT_TRACE = TypeMetadata(
    type=EntityType.AGENT_TRACE,
    from_disk_fn=extract_agent_trace,
    gen_uuid_fn=agent_trace_gen_id,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    creatable=False,
    icon="Route",
    api_visible=True,
    index_fields=["name", "session_id", "verdict"],
    asset_class="harness",
    harness="claude",
    family="agent_traces",
    main_layout="folder",
    main_file="trace.json",
    # asset_ref IS .claude/agent_traces/<name>/trace.json (the walker emits the
    # inner file), so create and rescan agree on the inner-file path.
    main_file_is_asset_ref=True,
    default_body_fn=_agent_trace_default_body,
    # The skill is the file's sole author; entity saves re-render trace.json —
    # but only when a payload is present (default_body_fn returns None
    # otherwise, and upsert_main_ref skips None bodies).
    owns_main_ref=True,
    meta_model=AgentTraceMeta,
)
