"""The lookups link resolution reads — from the database, or from one index run's memory.

An index run holds the SQLite writer lock across a batch of records, and every
record resolves its ``[[links]]``. Resolving each link against the database put
a load of the whole project (its children, every owned asset) inside that lock
per link, so one record could hold the lock past ``busy_timeout`` and fail every
other writer with "database is locked".

:func:`lookups` is what the resolver asks. Outside an index run it is
:class:`LinkLookups`, the database. Inside :func:`link_scope` it is a
:class:`LinkScope`: the same answers from maps built once per project per run,
with records the run writes folded in by ``note`` — so a link to an asset indexed
earlier in the same run resolves exactly as it would from the database.
"""

from __future__ import annotations

import contextlib
import contextvars
from typing import TYPE_CHECKING, Any, AsyncIterator

if TYPE_CHECKING:
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.wiki import Wiki, WikiEntry
    from flow_sdk.fs_store.type_id import TypeId


class LinkLookups:
    """Every read link resolution makes, answered by the database."""

    async def source_project_id(self, src_type: str, src_id: str) -> str | None:
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        model = SchemaRegistry.get_entity_cls(src_type)
        source = await model.get_one({"id": src_id}) if model else None
        project_id = getattr(source, "project_id", None) if source is not None else None
        return str(project_id) if project_id else None

    async def project(self, project_id: str) -> "Project | None":
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        return await Project.get_by_id(project_id)

    async def default_wiki(self, project: "Project") -> "Wiki":
        from .service import ensure_default_wiki  # noqa: PLC0415

        return await ensure_default_wiki(project)

    async def entries_for(self, wiki: "Wiki", word: str) -> list["WikiEntry"]:
        from flow_sdk.builtin.wiki import WikiEntry  # noqa: PLC0415

        return await WikiEntry.get_all({"parent_type_id": str(wiki.typeid), "word": word})

    async def project_assets(self, project: "Project", word: str) -> list["TypeId"]:
        from .service import _implicit_project_assets  # noqa: PLC0415

        return await _implicit_project_assets(project, word)

    def note(self, entity: Any) -> None:
        """A record was written. The database already knows."""


class _ProjectNames:
    """Every asset a project owns, by the word a link names it with."""

    def __init__(self) -> None:
        self.by_word: dict[str, dict[str, "TypeId"]] = {}
        self.words_of: dict[str, tuple[str, ...]] = {}

    def put(self, entity: Any) -> None:
        from .service import link_words  # noqa: PLC0415

        key = str(entity.typeid)
        for word in self.words_of.pop(key, ()):
            self.by_word.get(word, {}).pop(key, None)
        if not getattr(entity, "asset_ref", None):
            return
        words = link_words(entity)
        for word in words:
            self.by_word.setdefault(word, {})[key] = entity.typeid
        self.words_of[key] = words

    def lookup(self, word: str) -> list["TypeId"]:
        return list(self.by_word.get(word, {}).values())


class LinkScope(LinkLookups):
    """One index run's lookups: each read made once, then answered from memory."""

    def __init__(self) -> None:
        self.projects: dict[str, "Project | None"] = {}
        self.wikis: dict[str, "Wiki"] = {}
        self.entries: dict[str, dict[str, list["WikiEntry"]]] = {}
        self.names: dict[str, _ProjectNames] = {}
        self.source_projects: dict[tuple[str, str], str | None] = {}

    async def source_project_id(self, src_type: str, src_id: str) -> str | None:
        key = (src_type, src_id)
        if key not in self.source_projects:
            self.source_projects[key] = await super().source_project_id(src_type, src_id)
        return self.source_projects[key]

    async def project(self, project_id: str) -> "Project | None":
        if project_id not in self.projects:
            self.projects[project_id] = await super().project(project_id)
        return self.projects[project_id]

    async def default_wiki(self, project: "Project") -> "Wiki":
        key = str(project.id)
        if key not in self.wikis:
            self.wikis[key] = await super().default_wiki(project)
        return self.wikis[key]

    async def entries_for(self, wiki: "Wiki", word: str) -> list["WikiEntry"]:
        from flow_sdk.builtin.wiki import WikiEntry  # noqa: PLC0415

        key = str(wiki.typeid)
        if key not in self.entries:
            by_word: dict[str, list[WikiEntry]] = {}
            for entry in await WikiEntry.get_all({"parent_type_id": key}):
                by_word.setdefault(entry.word, []).append(entry)
            self.entries[key] = by_word
        return self.entries[key].get(word, [])

    async def project_assets(self, project: "Project", word: str) -> list["TypeId"]:
        key = str(project.id)
        if key not in self.names:
            self.names[key] = await _load_names(project)
        return self.names[key].lookup(word)

    def note(self, entity: Any) -> None:
        """Fold a record this run wrote into what links can resolve to — and remember
        its project, so its own links need no read to find it."""
        from .service import LINK_SKIP_TYPES  # noqa: PLC0415

        project_id = getattr(entity, "project_id", None)
        self.source_projects[(entity.get_type(), str(entity.id))] = str(project_id) if project_id else None
        if project_id and entity.get_type() not in LINK_SKIP_TYPES:
            names = self.names.get(str(project_id))
            if names is not None:
                names.put(entity)


async def _load_names(project: "Project") -> _ProjectNames:
    """The project's assets as ``_implicit_project_assets`` sees them: its children
    with an asset_ref, and every owned-asset row stamped with its project_id."""
    from .service import project_owner_classes  # noqa: PLC0415

    names = _ProjectNames()
    for child_ref in await project.get_children():
        child = getattr(child_ref, "value", child_ref)
        if child is not None:
            names.put(child)
    for entity_cls in project_owner_classes():
        for entity in await entity_cls.get_all({"project_id": str(project.id)}):
            names.put(entity)
    return names


_DATABASE = LinkLookups()
_current: contextvars.ContextVar[LinkScope | None] = contextvars.ContextVar("wiki_link_scope", default=None)


def lookups() -> LinkLookups:
    """The lookups to resolve with: the open index run's, else the database."""
    return _current.get() or _DATABASE


@contextlib.asynccontextmanager
async def link_scope() -> AsyncIterator[LinkScope]:
    """Resolve links from per-run memory until the block ends (nested: the outer scope)."""
    existing = _current.get()
    if existing is not None:
        yield existing
        return
    scope = LinkScope()
    token = _current.set(scope)
    try:
        yield scope
    finally:
        _current.reset(token)
