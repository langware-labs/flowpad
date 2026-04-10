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
    """Filesystem-backed agent entity. record_data_ref points to AgentRecord on disk."""

    type: str = APIField(default=BuiltinEntityType.AGENT.value)
    name: str | None = APIField(default=None)
    description: str | None = APIField(default=None)
    source_path: str = APIField(default="")
    _api_visible: bool = True
    _icon: ClassVar[str] = "Bot"

    async def store(self) -> None:
        agent_name = (self.name or "").strip()
        if not agent_name:
            return None

        import asyncio
        from pathlib import Path
        from flow_sdk.request_context.methods import get_current_request_info

        request_info = get_current_request_info()
        parent_project = None
        if (
            request_info
            and request_info.target_entity_typeid
            and request_info.target_entity_typeid.type == "project"
        ):
            parent_project = await request_info.get_target_entity()

        if parent_project and getattr(parent_project, "fs_storage_mount_path", None):
            root = Path(parent_project.fs_storage_mount_path)
        else:
            root = Path.home()

        agent_md_path = root / ".claude" / "agents" / f"{agent_name}.md"

        def _write() -> None:
            from flow_sdk.fs_store.fs_ref import FrontMatterFsRef
            doc = FrontMatterFsRef(agent_md_path)
            if not agent_md_path.exists():
                desc = (self.description or "").strip()
                doc.write_doc(
                    body="",
                    frontmatter={"name": agent_name, "description": desc},
                )

        try:
            await asyncio.to_thread(_write)
            self.source_path = str(agent_md_path)
        except Exception:
            pass

        return None
