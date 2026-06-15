"""Shared search-result filter helpers.

Used by both ``/api/v1/search`` (server/routes/search.py) and
``/fs-records/search`` (builtin/faas/fs_records_actions.py) so the two
surfaces apply identical post-FTS filtering. Without this, parameters the
UI sends (scope, include_system, parent_path, vault_root, tags) are
silently dropped by ``/fs-records/search``.
"""

from __future__ import annotations

from dataclasses import dataclass, field

SCOPED_RECORD_TYPES: frozenset[str] = frozenset({
    "skill", "agent", "markdown", "whiteboard", "workflow", "task",
    "claude_hook", "claude_rules", "claude_memory", "claude_md",
    "claude_session", "codex_session", "command", "spec",
})

# Scopes matched by ``project_id`` (i.e. that carry a project). System rows
# carry the system project's id, so selecting that project surfaces them just
# like ordinary project rows. Single source of truth for both the in-memory
# predicate (``apply_scope_filter``) and the SQL clause (``_scope_sql_clause``)
# and mirrored by the frontend ``PROJECT_LIKE_SCOPES`` (ui/src/lib/scope-filter.ts).
PROJECT_LIKE_SCOPES: frozenset[str] = frozenset({"project", "system"})


@dataclass(frozen=True)
class ScopeFilter:
    """Single source of truth for "which records does the user want".

    The wire fields mirror the frontend ``ScopeFilter`` in
    ``ui/src/components/assets/assetFilter.ts``.

    Fields:
      - ``user``     — include user-scope records.
      - ``projects`` — Project entity ids to include; empty = no projects.
      - ``record_projects`` — ids accepted when matching persisted
        ``record.project_id`` values. During the transition this includes the
        entity id and the legacy uuid5(project:<cwd>) id.
      - ``project_roots`` — backend-only ``(project_id, cwd)`` pairs used by
        scan/index paths that already resolved the all-project list and should
        not re-query or materialize Project rows just to build FS roots.

    Wire format on the URL:  ``?user=true&projects=A,B``
    """

    user: bool = True
    projects: tuple[str, ...] = field(default_factory=tuple)
    record_projects: tuple[str, ...] = field(default_factory=tuple)
    project_roots: tuple[tuple[str, str], ...] = field(default_factory=tuple)

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


def _dedupe(values) -> tuple[str, ...]:
    seen: set[str] = set()
    out: list[str] = []
    for raw in values:
        value = str(raw or "").strip()
        if not value or value in seen:
            continue
        seen.add(value)
        out.append(value)
    return tuple(out)


def _dedupe_pairs(values) -> tuple[tuple[str, str], ...]:
    seen: set[str] = set()
    out: list[tuple[str, str]] = []
    for raw_key, raw_value in values:
        key = str(raw_key or "").strip()
        value = str(raw_value or "").strip()
        if not key or not value or key in seen:
            continue
        seen.add(key)
        out.append((key, value))
    return tuple(out)


def scope_record_project_ids(sf: "ScopeFilter | None") -> tuple[str, ...]:
    """Project ids to compare against persisted record ``project_id`` fields."""
    if sf is None:
        return tuple()
    return _dedupe((*sf.projects, *sf.record_projects))


def apply_scope_filter(entities: list, sf: "ScopeFilter | None") -> list:
    """Filter entities by the unified ``ScopeFilter``.

    Predicate (uniform across all surfaces — search, fs-records, indexer):

      - ``scope == 'user'``    → keep iff ``sf.user``.
      - ``scope in ('project', 'system')`` → keep iff ``project_id`` is in
        ``sf.projects`` or ``sf.record_projects``. (System rows carry the
        system project's id, so selecting that project surfaces them; they
        stay hidden under any other scope.)
      - ``scope == ''``        → keep (unscoped record types like ``project``
        itself live here; they exist outside the user/project axis and the
        filter has nothing to say about them).

    Passing ``None`` returns entities unchanged — the canonical "no filter
    applied" path (used by code paths that pre-date the filter or want to
    explicitly opt out).
    """
    if sf is None:
        return entities
    pid_set = set(scope_record_project_ids(sf))

    # Record types that ALWAYS have a scope (user/project). Empty scope on
    # one of these means the record skipped the scope-stamp path (a bug, not
    # an exemption) — drop it under an explicit ScopeFilter so search doesn't
    # leak half-classified rows.
    def _keep(e) -> bool:
        s = (getattr(e, "scope", None) or "")
        if s == "user":
            return sf.user
        if s in PROJECT_LIKE_SCOPES:
            pid = getattr(e, "project_id", None) or ""
            return pid in pid_set
        # Empty scope on a normally-scoped type = drop. Other unscoped types
        # (e.g. 'project' itself) keep through.
        etype = str(getattr(e, "type", "") or "")
        if etype in SCOPED_RECORD_TYPES:
            return False
        return True

    return [e for e in entities if _keep(e)]


async def resolve_project_scope(
    sf: "ScopeFilter | None",
    *,
    create_missing: bool = False,
) -> "ScopeFilter | None":
    """Resolve project tokens to entity ids and record-match ids.

    System projects (e.g. ``@flowpad_assistant``) are referenced by their
    stable uname in URLs/footer, but records are stamped with the project's
    entity id — the indexer resolves the same way via
    ``lookup_project_id_by_uname``. Resolving here keeps the scope match
    symmetric with the stamp across every search surface.

    Compatibility: older fs-record rows may carry the derived
    uuid5(project:<cwd>) value in ``project_id``. ``projects`` is normalized to
    real Project entity ids; ``record_projects`` carries both the entity ids
    and derived ids so row filters still match existing records.
    """
    if sf is None or not sf.projects:
        return sf
    if sf.record_projects:
        return sf
    from flow_sdk.builtin.project import Project  # noqa: PLC0415
    from flow_sdk.fs_store.identifier import is_valid_uuid  # noqa: PLC0415
    from flow_sdk.fs_store.indexer.roots import lookup_project_id_by_uname  # noqa: PLC0415
    from flow_sdk.fs_store.operations.all_projects import get_all_projects  # noqa: PLC0415

    projects = await Project.get_all()
    by_id = {str(p.id): p for p in projects if getattr(p, "id", None)}
    by_record_id: dict[str, Project] = {}
    for proj in projects:
        candidates = [
            getattr(proj, "project_id", None),
            Project.derive_id_for_path(getattr(proj, "fs_storage_mount_path", None)),
        ]
        for candidate in candidates:
            key = str(candidate or "").strip()
            if key and key not in by_record_id:
                by_record_id[key] = proj

    normalized_tokens: list[str] = []
    needs_project_infos = False
    for tok in sf.projects:
        token = str(tok or "").strip()
        if not token:
            continue
        if not is_valid_uuid(token):
            token = lookup_project_id_by_uname(token[1:] if token.startswith("@") else token) or token
        normalized_tokens.append(token)
        if token in by_record_id and token not in by_id:
            needs_project_infos = True

    info_by_id = {}
    info_by_record_id = {}
    if needs_project_infos:
        project_infos = await get_all_projects(create_missing=create_missing)
        info_by_id = {str(info.project_id): info for info in project_infos if info.project_id}
        for info in project_infos:
            candidates = [
                info.record_project_id,
                Project.derive_id_for_path(info.cwd),
            ]
            for candidate in candidates:
                key = str(candidate or "").strip()
                if key and key not in info_by_record_id:
                    info_by_record_id[key] = info

    entity_ids: list[str] = []
    record_ids: list[str] = []
    project_roots: list[tuple[str, str]] = []

    def add_project_info(info) -> None:
        pid = str(getattr(info, "project_id", "") or "").strip()
        if pid:
            entity_ids.append(pid)
            record_ids.append(pid)
            cwd = str(getattr(info, "cwd", "") or "").strip()
            if cwd:
                project_roots.append((pid, cwd))
        record_pid = str(getattr(info, "record_project_id", "") or "").strip()
        if record_pid:
            record_ids.append(record_pid)
        derived = Project.derive_id_for_path(getattr(info, "cwd", None))
        if derived:
            record_ids.append(derived)

    def add_project(proj) -> None:
        pid = str(getattr(proj, "id", "") or "").strip()
        if pid:
            entity_ids.append(pid)
            record_ids.append(pid)
            mount = str(getattr(proj, "fs_storage_mount_path", "") or "").strip()
            if mount:
                project_roots.append((pid, mount))
        legacy_pid = str(getattr(proj, "project_id", "") or "").strip()
        if legacy_pid:
            record_ids.append(legacy_pid)
        derived = Project.derive_id_for_path(getattr(proj, "fs_storage_mount_path", None))
        if derived:
            record_ids.append(derived)

    for token in normalized_tokens:
        info = info_by_id.get(token)
        if info is not None:
            add_project_info(info)
            continue

        info = info_by_record_id.get(token)
        if info is not None:
            add_project_info(info)
            record_ids.append(token)
            continue

        proj = by_id.get(token)
        if proj is not None:
            add_project(proj)
            continue

        proj = by_record_id.get(token)
        if proj is not None:
            add_project(proj)
            record_ids.append(token)
            continue

        # Unknown token: preserve it so callers get existing 404 / empty-match
        # behavior, and so non-Project-scoped custom ids keep matching rows.
        entity_ids.append(token)
        record_ids.append(token)

    resolved_projects = _dedupe(entity_ids)
    resolved_records = _dedupe(record_ids)
    resolved_roots = _dedupe_pairs((*sf.project_roots, *project_roots))
    if (
        resolved_projects == sf.projects
        and resolved_records == sf.record_projects
        and resolved_roots == sf.project_roots
    ):
        return sf
    return ScopeFilter(
        user=sf.user,
        projects=resolved_projects,
        record_projects=resolved_records,
        project_roots=resolved_roots,
    )


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


def apply_system_filter(
    entities: list,
    include_system: bool,
    scoped_project_ids: "tuple[str, ...] | set[str] | None" = None,
) -> list:
    """Drop system-project entities unless the caller opted in.

    A system entity is *kept* when its project is explicitly in scope
    (``scoped_project_ids``), so the listing path matches the count path: the
    scope clause already counts system rows whose ``project_id`` is selected,
    and this keeps them in the rendered list too. Everything else system-tagged
    is still dropped unless ``include_system``.
    """
    if include_system:
        return entities
    scoped = set(scoped_project_ids or ())
    return [
        e
        for e in entities
        if not getattr(e, "system", False)
        or (getattr(e, "project_id", None) or "") in scoped
    ]


def apply_tag_filter(entities: list, tag_list: list[str]) -> list:
    """Keep entities whose `tags` field contains every tag in `tag_list` (AND)."""
    if not tag_list:
        return entities
    return [
        e for e in entities
        if all(t in (getattr(e, "tags", None) or []) for t in tag_list)
    ]
