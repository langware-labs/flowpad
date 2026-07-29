"""Skill entity — graph/HTTP surface for FSRecord(type='skill').

On-disk parsing (walker / id / extract) lives in
``fs_store/indexer/functions/skill.py`` and is wired to the indexer via
``TypeInfo`` callable slots, not classmethods on this entity.
"""
from __future__ import annotations

from typing import ClassVar, Type

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.core.entity.context_data_schemas import SkillContextData
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType


class Skill(Entity):
    """Skill entity — backed by FSRecord(type='skill').

    On-disk layout: ``<scope>/.claude/skills/<name>/SKILL.md`` (+ optional
    ``skill.yaml``). Folder is the asset; SKILL.md frontmatter carries the
    deterministic id.
    """

    type: str = APIField(default=BuiltinEntityType.SKILL.value)
    name: str = APIField(default="")
    description: str = APIField(default="")
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
    body: str = APIField(default="")
    metadata: dict | None = APIField(default=None)

    context_data_schema: ClassVar[Type] = SkillContextData
    # A Skill's asset is the whole folder. Hub transport preserves every
    # relative file while its primary content remains canonically /SKILL.md.
    _hub_asset_layout: ClassVar[str] = "folder"
    _hub_main_file: ClassVar[str] = "SKILL.md"
