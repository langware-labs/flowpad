"""Monitor entity -- a session's goal watched on a clock (``flow process monitor``).

The ROW; its shape on disk is ``MonitorSpec`` (``monitor.json``, ``TypeInfo.asset_spec``). The cron
trigger that checks it sits beside it under the same key and runs ``flow process monitor-nudge <key>``.
"""
from __future__ import annotations

from typing import Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.monitor_spec import NudgeLogEntry
from flow_sdk.schema.types import EntityType


class Monitor(Entity):
    type: str = APIField(default=EntityType.MONITOR.value)
    name: str = APIField("")
    agentic_process_id: str = APIField("", description="The agentic process whose goal is watched")
    goal: str = APIField("", description="What done looks like")
    stop_condition: str = APIField("", description="When to stop even if the goal is not met")
    cron: str = APIField("", description="When to check: a crontab mask")
    nudge_log: list[NudgeLogEntry] = APIField(default_factory=list, description="The result of each nudge, oldest first")
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)
