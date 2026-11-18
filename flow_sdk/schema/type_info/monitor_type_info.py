"""Type metadata for MONITOR -- a session's goal watched on a clock.

A REPO folder asset at ``agentic-assets/monitor/<process id>_monitor_<name>/monitor.json``
(``MonitorSpec``), written by ``flow process monitor``; its cron trigger sits beside it at
``agentic-assets/trigger/<same key>/``. Identity is a writable folder capsule, as for a trigger.
"""
from flow_sdk.assets.identity import folder_json_identity
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.data_spec.monitor_spec import MonitorSpec
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

MONITOR = TypeInfo(
    type_name=EntityType.MONITOR,
    icon="Radar",
    display_name="Monitors",
    api_visible=True,
    indexed_by_default=True,
    browseable_by=ViewMode.ADVANCED,
    asset_class="repo",
    family="monitor",
    asset_spec=MonitorSpec,
    identity_carrier=folder_json_identity(),
    fts_content=("name", "goal", "stop_condition"),
    index_fields=["name", "process_id"],
)
