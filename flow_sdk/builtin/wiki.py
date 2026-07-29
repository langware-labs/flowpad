"""First-class Wiki namespaces and their word-to-asset bindings."""

from __future__ import annotations

from flow_sdk.api.api_types.api_field import APIField, Persist
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class Wiki(Entity):
    """A DB-only namespace owned by one Project."""

    type: str = APIField(default=EntityType.WIKI.value, persist=Persist.FALSE)
    name: str = APIField(default="", persist=Persist.FALSE)
    project_id: str = APIField(default="", persist=Persist.FALSE)

    async def store(self):
        """Wiki has no filesystem record or content."""
        return None

    @classmethod
    async def get_by_uname(cls, uname: str):
        """Resolve ``@local`` to the local Project's default Wiki.

        ``@local`` is an app-local alias, not the Wiki's stored uname and not a
        Hub convention. Keeping the translation at entity lookup makes the
        normal graph grammar work for GET and every Wiki action while named
        Wikis continue through the generic uname lookup.
        """
        if uname != "local":
            return await super().get_by_uname(uname)

        from flow_sdk.builtin.project import Project
        from flow_sdk.wiki.service import ensure_default_wiki

        project = await Project.get_by_uname("local")
        return await ensure_default_wiki(project) if project is not None else None


class WikiEntry(Entity):
    """A DB-only canonical word binding owned by one Wiki."""

    type: str = APIField(default=EntityType.WIKI_ENTRY.value, persist=Persist.FALSE)
    word: str = APIField(default="", persist=Persist.FALSE)
    target_typeid: TypeId = APIField(persist=Persist.FALSE)

    async def store(self):
        """WikiEntry has no filesystem record or content."""
        return None
