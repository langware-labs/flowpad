"""An assignee moves the work along; they don't get to rewrite the ask.

One shared task row + whole-row LWW (``Entity.is_stale``) + a client that PUTs
its entire snapshot = a status click that reverts the owner's title and body.
Measured live on dev-1/dev-2 before this filter existed.

NOTE on import order: ``register_all()`` must run BEFORE ``flow_sdk.builtin.task``
is imported. Importing the entity module first registers a bare ``TypeInfo`` that
the declarative registration will not replace, and every runtime-only field
(``local_fields``, ``assignee_owned_fields``, …) then reads empty — the test
would pass for the wrong reason.
"""

from __future__ import annotations

import pytest

from flow_sdk.schema.type_info import register_all

register_all()

from flow_sdk.builtin.task import Task  # noqa: E402
from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: E402
from flow_sdk.server.routes._hub_reflect import scope_body_to_assignee_fields  # noqa: E402

STALE = {"title": "stale title", "description": "stale body", "status": "done"}
TID = "11111111-1111-4111-8111-111111111111"


@pytest.fixture
def as_bob(monkeypatch):
    """Bob is the CLOUD identity — the filter reads the instance's stored user
    record, not the desktop ``User.get_local()`` (those differ on every instance;
    conflating them made the filter silently no-op against the live hub)."""
    monkeypatch.setattr(
        "flow_sdk.cli.app_config.get_user", lambda *a, **k: {"email": "bob@x.test"}, raising=True
    )


def test_task_declares_the_assignee_owned_fields():
    assert SchemaRegistry.get("task").assignee_owned_fields == ("status", "completed_at")


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_the_assignee_only_ships_the_fields_they_own(as_bob):
    task = Task(id=TID, title="real title", assignee="bob@x.test", reporter="alice@x.test")
    assert scope_body_to_assignee_fields(task, STALE) == {"status": "done"}


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_the_owner_ships_everything(as_bob):
    """Bob writing a task assigned to someone else is its author — no scoping."""
    task = Task(id=TID, title="real title", assignee="carol@x.test", reporter="bob@x.test")
    assert scope_body_to_assignee_fields(task, STALE) == STALE


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_self_assignment_is_not_scoped(as_bob):
    task = Task(id=TID, title="real title", assignee="bob@x.test", reporter="bob@x.test")
    assert scope_body_to_assignee_fields(task, STALE) == STALE


@pytest.mark.timeout(30)  # do not increase timeout without approval
def test_an_unassigned_task_is_untouched(as_bob):
    assert scope_body_to_assignee_fields(Task(id=TID), STALE) == STALE
