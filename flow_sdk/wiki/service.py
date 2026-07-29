"""Wiki lifecycle, binding, and project-scoped resolution."""

from __future__ import annotations

import uuid
from typing import Any

from flow_sdk.api.api_types.identifier import mint_uuid
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.wiki import Wiki, WikiEntry
from flow_sdk.fs_store.schema_registry import SchemaRegistry

from .parser import canonicalize_word

WIKI_ID_NAMESPACE = uuid.NAMESPACE_URL
WIKI_ENTRY_ID_NAMESPACE = uuid.NAMESPACE_OID


def default_wiki_id(project_id: str) -> str:
    return mint_uuid(
        f"project:{project_id}:default-wiki",
        namespace=WIKI_ID_NAMESPACE,
    )


def wiki_entry_id(wiki_id: str, word: str) -> str:
    canonical = canonicalize_word(word)
    return mint_uuid(
        f"wiki:{wiki_id}:word:{canonical}",
        namespace=WIKI_ENTRY_ID_NAMESPACE,
    )


async def ensure_default_wiki(project: Project) -> Wiki:
    """Return the Project's stable default Wiki, repairing its child edge."""
    wiki_id = default_wiki_id(str(project.id))
    wiki = await Wiki.get_by_id(wiki_id)
    expected_parent = str(project.typeid)
    if wiki is None:
        wiki = Wiki(
            id=wiki_id,
            uname=f"wiki-{project.id}",
            name=f"{project.name or project.uname or 'Project'} Wiki",
            project_id=str(project.id),
            parent_type_id=expected_parent,
        )
        await project.add_child(wiki)
        return wiki

    dirty = False
    if wiki.project_id != str(project.id):
        wiki.project_id = str(project.id)
        dirty = True
    if wiki.parent_type_id != expected_parent:
        wiki.parent_type_id = expected_parent
        dirty = True
    if dirty:
        await wiki.save()
    await project.attach_child(wiki)
    return wiki


async def bind(wiki: Wiki, word: str, target_typeid: TypeId | str) -> WikiEntry:
    """Idempotently bind a canonical word to a readable local entity."""
    canonical = canonicalize_word(word)
    target = TypeId.to_typeid(target_typeid)
    target_model = SchemaRegistry.get_entity_cls(target.type)
    if target_model is None or target.id is None:
        raise ValueError("Target entity not found")
    target_entity = await target_model.get_one({"id": target.id})
    if target_entity is None:
        raise ValueError("Target entity not found")

    entry_id = wiki_entry_id(str(wiki.id), canonical)
    entry = await WikiEntry.get_by_id(entry_id)
    if entry is None:
        entry = WikiEntry(
            id=entry_id,
            word=canonical,
            target_typeid=target,
            parent_type_id=str(wiki.typeid),
        )
        await wiki.add_child(entry)
        return entry

    entry.word = canonical
    entry.target_typeid = target
    entry.parent_type_id = str(wiki.typeid)
    await entry.save()
    await wiki.attach_child(entry)
    return entry


async def unbind(wiki: Wiki, word: str) -> bool:
    """Delete the deterministic binding when present; repeated calls succeed."""
    entry = await WikiEntry.get_by_id(wiki_entry_id(str(wiki.id), word))
    if entry is not None:
        await entry.delete()
    return True


def _result(kind: str, *, target: TypeId | None = None, source: str | None = None) -> dict[str, Any]:
    data: dict[str, Any] = {"kind": kind}
    if target is not None:
        data["target_typeid"] = str(target)
    if source is not None:
        data["source"] = source
    return data


async def _existing_targets(entries: list[WikiEntry]) -> list[TypeId]:
    targets: dict[str, TypeId] = {}
    for entry in entries:
        target = entry.target_typeid
        if target.id is None:
            continue
        model = SchemaRegistry.get_entity_cls(target.type)
        if model is None:
            continue
        if await model.get_one({"id": target.id}) is not None:
            targets[str(target)] = target
    return list(targets.values())


def _matches_word(entity: Any, canonical: str) -> bool:
    return any(
        isinstance(value, str) and value == canonical
        for value in (getattr(entity, "uname", None), getattr(entity, "name", None))
    )


async def _implicit_project_assets(project: Project, canonical: str) -> list[TypeId]:
    """Find project-owned file/folder assets without a global name query."""
    matches: dict[str, TypeId] = {}

    # Relationship ownership is authoritative when present.
    for child_ref in await project.get_children():
        child = getattr(child_ref, "value", child_ref)
        if child is None or not getattr(child, "asset_ref", None):
            continue
        if _matches_word(child, canonical):
            matches[str(child.typeid)] = child.typeid

    # Indexed local assets also carry the established project_id stamp. Some
    # legacy index paths predate Project child edges, so retain that local
    # ownership seam while the graph converges.
    for entity_cls in SchemaRegistry.get_all_entity_classes():
        fields = getattr(entity_cls, "model_fields", {})
        if "project_id" not in fields or "asset_ref" not in fields:
            continue
        if entity_cls.get_type() in {"project", "wiki", "wiki_entry"}:
            continue
        for entity in await entity_cls.get_all({"project_id": str(project.id)}):
            if getattr(entity, "asset_ref", None) and _matches_word(entity, canonical):
                matches[str(entity.typeid)] = entity.typeid
    return list(matches.values())


async def resolve(wiki: Wiki, word: str) -> dict[str, Any]:
    canonical = canonicalize_word(word)
    entries = await WikiEntry.get_all(
        {
            "parent_type_id": str(wiki.typeid),
            "word": canonical,
        }
    )
    if entries:
        targets = await _existing_targets(entries)
        if not targets:
            return _result("missing")
        if len(targets) > 1:
            return _result("ambiguous")
        return _result("resolved", target=targets[0], source="entry")

    project = await Project.get_by_id(str(wiki.project_id)) if wiki.project_id else None
    if project is None or str(wiki.id) != default_wiki_id(str(project.id)):
        return _result("missing")

    candidates = await _implicit_project_assets(project, canonical)
    if not candidates:
        return _result("missing")
    if len(candidates) > 1:
        return _result("ambiguous")
    return _result("resolved", target=candidates[0], source="implicit")


async def resolve_legacy_unscoped(word: str) -> dict[str, Any]:
    """Compatibility resolver for the deprecated non-graph endpoint.

    It intentionally has no type preference: a global collision is ambiguous,
    never an arbitrary winner.
    """
    from .store import get_async_default_store

    canonical = canonicalize_word(word)
    candidates = sorted(set(await get_async_default_store().find_entities_by_uname_or_name(canonical)))
    if not candidates:
        return _result("missing")
    targets: list[TypeId] = []
    for type_name, entity_id in candidates:
        try:
            target = TypeId(type=type_name, id=entity_id)
        except ValueError:
            # Old databases may contain pre-policy identifiers. They remain
            # resolvable only through occurrence APIs, not as entity identities.
            continue
        model = SchemaRegistry.get_entity_cls(target.type)
        if model is not None and target.id is not None and await model.get_one({"id": target.id}) is not None:
            targets.append(target)
    if not targets:
        return _result("missing")
    if len({str(target) for target in targets}) > 1:
        return _result("ambiguous")
    return _result("resolved", target=targets[0], source="implicit")
