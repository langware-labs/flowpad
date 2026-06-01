"""Agent entity — graph/HTTP surface for FSRecord(type='agent').

On-disk parsing lives in ``fs_store/indexer/functions/agent.py`` and is wired
to the indexer via ``TypeInfo`` callable slots, not classmethods here.
"""
from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity


class Agent(Entity):
    """Filesystem-backed agent entity. Source: ``<scope>/.claude/agents/<name>.md``."""

    type: str = APIField(default=BuiltinEntityType.AGENT.value)
    name: str | None = APIField(default=None)
    description: str | None = APIField(default=None)
    asset_ref: str = APIField(default="")
