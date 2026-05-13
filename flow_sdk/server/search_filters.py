"""Shared search-result filter helpers.

Used by both ``/api/v1/search`` (server/routes/search.py) and
``/fs-records/search`` (builtin/faas/fs_records_actions.py) so the two
surfaces apply identical post-FTS filtering. Without this, parameters the
UI sends (scope, include_system, parent_path, vault_root, tags) are
silently dropped by ``/fs-records/search``.
"""

from __future__ import annotations


def apply_scope_filter(entities: list, scope: str | None, project_ids: str | None) -> list:
    """Filter entities by scope and optional project IDs.

    `scope` may be a single value (`user` / `project` / `system`) or a
    comma-separated set (`user,project`). Comma-separated form means union:
    keep entities whose `scope` is in the listed set. When `project` is in
    the set and `project_ids` is given, project-scoped entities are
    additionally restricted to those project IDs; non-project-scoped
    entities are unaffected.

    Entities without a populated `scope` field are dropped — by
    construction the indexer stamps every record's scope from the FSRef
    walk, so an empty value means an unindexed/legacy row that needs
    reindexing.
    """
    if not scope:
        return entities
    scope_set = {s.strip() for s in scope.split(",") if s.strip()}
    if not scope_set:
        return entities

    pid_list = [p.strip() for p in project_ids.split(",") if p.strip()] if project_ids else []
    pid_set = set(pid_list)

    def _keep(e) -> bool:
        s = (getattr(e, "scope", None) or "")
        if s not in scope_set:
            return False
        if s == "project" and pid_set and (getattr(e, "project_id", None) or "") not in pid_set:
            return False
        return True

    return [e for e in entities if _keep(e)]


def apply_folder_filter(entities: list, parent_path: str | None, vault_root: str | None) -> list:
    """Filter entities by parent_path (exact) and/or vault_root (exact)."""
    if not parent_path and not vault_root:
        return entities
    filtered = entities
    if parent_path:
        filtered = [e for e in filtered if (getattr(e, "parent_path", None) or "") == parent_path]
    if vault_root:
        filtered = [e for e in filtered if (getattr(e, "vault_root", None) or "") == vault_root]
    return filtered


def apply_system_filter(entities: list, include_system: bool) -> list:
    """Drop system-project entities unless the caller opted in."""
    if include_system:
        return entities
    return [e for e in entities if not getattr(e, "system", False)]


def apply_tag_filter(entities: list, tag_list: list[str]) -> list:
    """Keep entities whose `tags` field contains every tag in `tag_list` (AND)."""
    if not tag_list:
        return entities
    return [
        e for e in entities
        if all(t in (getattr(e, "tags", None) or []) for t in tag_list)
    ]
