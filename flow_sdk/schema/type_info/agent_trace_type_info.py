"""Type metadata for AGENT_TRACE."""
from flow_sdk.builtin.agent_trace import AgentTraceSpec
from flow_sdk.schema.type_info._report import report_type_info
from flow_sdk.schema.types import EntityType

AGENT_TRACE = report_type_info(
    type=EntityType.AGENT_TRACE,
    icon="Route",
    asset_spec=AgentTraceSpec,
    index_fields=["name", "session_id", "verdict"],
    fts_content=("name", "verdict", "verdict_reason"),
    main_file="trace.json",
)
