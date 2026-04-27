from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Skill(Entity):
    """Skill entity — backed by a SkillRecord on disk (~/.claude/skills/<name>/).

    Creating a Skill entity via save() writes the skill folder and SKILL.md stub.
    The Record layer (SkillRecord) is the source of truth; this Entity provides
    the graph-route interface (POST /api/v1/graph/skill → create, GET → list).

    Scope-aware via the framework hook on Entity.save(): POST /api/v1/graph/
    project/<id>/skill writes to <project.fs_storage_mount_path>/.claude/skills/
    <name>/; bare POST writes to ~/.claude/skills/<name>/. Path layout +
    default body live on SkillRecord (``_main_subdir``, ``default_body``).
    """

    type: str = APIField(default=BuiltinEntityType.SKILL.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="")
    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str] = "Sparkles"
