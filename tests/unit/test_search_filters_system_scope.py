"""System-scope visibility through the project filter.

`apply_scope_filter` (the in-memory predicate) and `apply_system_filter` (the
listing-path system gate) must agree with the SQL clause so a side-menu count
and its expanded list never disagree: a `scope='system'` row is visible iff its
project is explicitly in scope.
"""

from __future__ import annotations

from types import SimpleNamespace

from flow_sdk.server.search_filters import (
    ScopeFilter,
    apply_scope_filter,
    apply_system_filter,
)


def _ent(**kw) -> SimpleNamespace:
    base = {"type": "skill", "scope": "", "project_id": None, "system": False}
    base.update(kw)
    return SimpleNamespace(**base)


def test_apply_scope_filter_keeps_system_only_when_project_selected() -> None:
    sys_row = _ent(scope="system", project_id="sys-P", system=True)
    proj_row = _ent(scope="project", project_id="proj-A")
    user_row = _ent(scope="user")
    rows = [sys_row, proj_row, user_row]

    # System project selected → system row kept (alongside nothing else).
    kept = apply_scope_filter(rows, ScopeFilter(user=False, projects=("sys-P",)))
    assert kept == [sys_row]

    # A different project → system row dropped.
    kept = apply_scope_filter(rows, ScopeFilter(user=False, projects=("proj-A",)))
    assert kept == [proj_row]

    # User-only → system row dropped.
    kept = apply_scope_filter(rows, ScopeFilter(user=True, projects=()))
    assert kept == [user_row]


def test_apply_system_filter_keeps_system_rows_of_scoped_projects() -> None:
    sys_p = _ent(scope="system", project_id="sys-P", system=True)
    sys_other = _ent(scope="system", project_id="sys-Q", system=True)
    plain = _ent(scope="project", project_id="proj-A")
    rows = [sys_p, sys_other, plain]

    # No opt-in, no scoped projects → both system rows stripped.
    assert apply_system_filter(rows, include_system=False) == [plain]

    # sys-P explicitly scoped → its system row survives, sys-Q's does not.
    assert apply_system_filter(rows, include_system=False, scoped_project_ids=("sys-P",)) == [
        sys_p,
        plain,
    ]

    # Global opt-in keeps everything regardless of scope.
    assert apply_system_filter(rows, include_system=True) == rows
