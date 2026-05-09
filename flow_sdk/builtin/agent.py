"""Slim Agent entity — a desktop agent backed by a filesystem AgentRecord (.md file).

Each Agent entity has:
  - name / description
  - record_data_ref → "agent/<name>" pointing to the companion AgentRecord

Cloud-only concepts (KnowledgeBase, LLM routing, CheckpointMode, etc.) are
intentionally absent. Use flow_sdk.builtin.agent_config for those types if needed
by cloud-path code.
"""

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity


class Agent(Entity):
    """Filesystem-backed agent entity. record_data_ref points to AgentRecord on disk.

    Path layout (``<scope_root>/.claude/agents/<name>.md``) and default body
    live on AgentRecord (``_main_subdir``, ``default_body``). Entity.save()
    resolves scope from request_context once and the framework hook calls
    ``record.upsert_main_ref(self)``.
    """

    type: str = APIField(default=BuiltinEntityType.AGENT.value)
    name: str | None = APIField(default=None)
    description: str | None = APIField(default=None)
    asset_ref: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Bot"
