"""DOWNLOADED phase: a received-but-not-installed asset must carry NO scope.

Per the reception phase model (docs/collab/messages-and-attachments.md §6):

    Phase 2 DOWNLOADED  … every payload entry has a MessageAttachment row
                          (scope=None).
    Phase 4 INSTALLED   … reindex with the chosen scope/project stamped.

Bug: the save chokepoint gates only the *file write* on ``_SUPPRESS_STORE``
(``entity_model.py``), not ``_stamp_scope``. So a DB-only placeholder — never
written to disk — is still given a phantom user-home ``asset_ref`` and stamped
``'user'``, i.e. it shows up as personal before the user installs anything.

No mocks: real Task entity, the real ``_save_entity_db_only`` unpack helper,
the real test DB, and the real ``apply_scope_filter`` predicate.
"""

from __future__ import annotations

import pytest

import flow_sdk.fs_store.indexer.registrations  # noqa: F401
from flow_sdk.builtin.flow_message_bundle import _save_entity_db_only
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.server.search_filters import ScopeFilter, apply_scope_filter

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval

TASK_ID = "5ba90c17-2d41-4e88-9c3a-7f1e2d6b4a05"
PROJECT_ID = "3f2b8c14-77ad-4e29-9b60-1c5e8a90d742"


async def _downloaded_task():
    """Materialize a received task exactly as unpack does: projectless, DB-only."""
    task_cls = SchemaRegistry.get_entity_cls("task")
    assert task_cls is not None, "task entity class not registered"
    # Mirrors the real unpack payload (flow_message_bundle.py): a received task
    # is projectless AND explicitly declares no scope — DOWNLOADED is unscoped.
    task = task_cls.model_validate(
        {"id": TASK_ID, "title": "ex7a", "status": "to_do", "project_id": None, "scope": None}
    )
    await _save_entity_db_only(task, None)
    return (await task_cls.get_all({"id": TASK_ID}))[0]


async def test_downloaded_asset_has_no_scope() -> None:
    saved = await _downloaded_task()
    assert saved.scope in (None, ""), (
        f"DOWNLOADED asset must carry no scope until install, but was born "
        f"scope={saved.scope!r} (asset_ref={getattr(saved, 'asset_ref', None)!r})"
    )


async def test_scopeless_asset_is_hidden_from_user_and_project_views() -> None:
    """Safety property: an unscoped asset must not leak into any scoped view.

    Guards the DOWNLOADED=no-scope design — a scope-less scoped type is dropped
    under an explicit ScopeFilter, so it appears only in unfiltered ("All")
    surfaces, never in a project's or the user's bucket.
    """
    saved = await _downloaded_task()

    project_view = apply_scope_filter([saved], ScopeFilter(user=False, projects=(PROJECT_ID,)))
    assert project_view == [], "unscoped asset leaked into a project-scoped view"

    user_view = apply_scope_filter([saved], ScopeFilter(user=True, projects=()))
    assert user_view == [], "unscoped asset leaked into the user-scoped view"

    unfiltered = apply_scope_filter([saved], None)
    assert unfiltered == [saved], "unscoped asset should still be visible unfiltered"
