"""Shared search-result filter helpers.

Used by both ``/api/v1/search`` (server/routes/search.py) and
``/fs-records/search`` (builtin/faas/fs_records_actions.py) so the two
surfaces apply identical post-FTS filtering. Without this, parameters the
UI sends (scope, include_system, parent_path, vault_root, tags) are
silently dropped by ``/fs-records/search``.
"""

from __future__ import annotations

from dataclasses import dataclass, field


@dataclass(frozen=True)
class ScopeFilter:
    """Single source of truth for "which records does the user want".

    Mirrors the frontend ``ScopeFilter`` in
    ``ui/src/components/assets/assetFilter.ts`` exactly.

    Fields:
      - ``user``     — include user-scope records.
      - ``projects`` — entity-IDs of projects to include; empty = no projects.

    Wire format on the URL:  ``?user=true&projects=A,B``
    """

    user: bool = True
    projects: tuple[str, ...] = field(default_factory=tuple)

    @classmethod
    def from_query_params(cls, params) -> "ScopeFilter":
        """Build from a Starlette / FastAPI ``request.query_params`` (or dict-like).

        Tolerates either string keys or already-typed dict entries. Missing
        ``user`` defaults to True; missing ``projects`` defaults to empty.
        """
        user_raw = (
            params.get("user")
            if hasattr(params, "get")
            else params.get("user", None)  # type: ignore[union-attr]
        )
        if user_raw is None:
            user = True
        else:
            user = str(user_raw).strip().lower() in ("true", "1", "yes")
        projects_raw = (
            params.get("projects") if hasattr(params, "get") else params.get("projects", "")
        ) or ""
        projects = tuple(p.strip() for p in str(projects_raw).split(",") if p.strip())
        return cls(user=user, projects=projects)

    def to_query_dict(self) -> dict[str, str]:
        """Inverse of ``from_query_params`` for outbound URLs."""
        return {
            "user": "true" if self.user else "false",
            "projects": ",".join(self.projects),
        }


def apply_scope_filter(entities: list, sf: "ScopeFilter | None") -> list:
    """Filter entities by the unified ``ScopeFilter``.

    Predicate (uniform across all surfaces — search, fs-records, indexer):

      - ``scope == 'user'``    → keep iff ``sf.user``.
      - ``scope == 'project'`` → keep iff ``project_id`` is in ``sf.projects``.
      - ``scope == ''``        → keep (unscoped record types like ``project``
        itself live here; they exist outside the user/project axis and the
        filter has nothing to say about them).

    Passing ``None`` returns entities unchanged — the canonical "no filter
    applied" path (used by code paths that pre-date the filter or want to
    explicitly opt out).
    """
    if sf is None:
        return entities
    pid_set = set(sf.projects)

    # Record types that ALWAYS have a scope (user/project). Empty scope on
    # one of these means the record skipped the scope-stamp path (a bug, not
    # an exemption) — drop it under an explicit ScopeFilter so search doesn't
    # leak half-classified rows.
    _SCOPED_TYPES: frozenset[str] = frozenset({
        "skill", "agent", "markdown", "whiteboard", "workflow", "task",
        "claude_hook", "claude_rules", "claude_memory", "claude_md",
        "claude_session", "codex_session", "command", "spec",
    })

    def _keep(e) -> bool:
        s = (getattr(e, "scope", None) or "")
        if s == "user":
            return sf.user
        if s == "project":
            pid = getattr(e, "project_id", None) or ""
            return pid in pid_set
        # Empty scope on a normally-scoped type = drop. Other unscoped types
        # (e.g. 'project' itself) keep through.
        etype = str(getattr(e, "type", "") or "")
        if etype in _SCOPED_TYPES:
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
