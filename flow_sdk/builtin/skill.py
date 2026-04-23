from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Skill(Entity):
    """Skill entity — backed by a SkillRecord on disk (~/.claude/skills/<name>/).

    Creating a Skill entity via save() writes the skill folder and SKILL.md stub.
    The Record layer (SkillRecord) is the source of truth; this Entity provides the
    graph-route interface (POST /api/v1/graph/skill → create, GET → list/read).

    Scope-aware: POST /api/v1/graph/project/<id>/skill writes to
    <project.fs_storage_mount_path>/.claude/skills/<name>/; bare POST writes to
    ~/.claude/skills/<name>/.
    """

    type: str = APIField(default=BuiltinEntityType.SKILL.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Sparkles"

    async def store(self) -> None:
        skill_name = self.name.strip()
        if not skill_name:
            return None

        import asyncio
        from pathlib import Path
        from flow_sdk.request_context.methods import get_current_request_info

        # Determine root: project dir or home
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

        skill_md_path = root / ".claude" / "skills" / skill_name / "SKILL.md"

        def _write():
            skill_md_path.parent.mkdir(parents=True, exist_ok=True)
            if not skill_md_path.exists():
                desc = (self.description or "").strip()
                skill_md_path.write_text(
                    f'---\nname: {skill_name}\ndescription: "{desc}"\n---\n\n# {skill_name}\n\n',
                    encoding="utf-8",
                )

        try:
            await asyncio.to_thread(_write)
            self.asset_ref = str(skill_md_path.parent)
        except Exception:
            pass

        return None
