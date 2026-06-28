"""``Conversation.resolve_project_id`` — the single deterministic resolver every
conversation init point (local create, share, hub receive) calls so a
conversation's owning project is computed ONCE from the SHARED/TARGET entity,
never from the client's ambient "active project".

Mirrors the Tab rule (``tab._project_of_target``): the project follows the
shared entity. The request/scope ``project_id`` is only a fallback, and an
entity-less cross-user chat is left project-less (None) by design.
"""
from __future__ import annotations

import uuid

import pytest

# Importing the entity registers the type (Entity.__init_subclass__).
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.whiteboard import Whiteboard  # noqa: F401


@pytest.mark.asyncio
async def test_resolves_from_shared_entity_over_ambient_fallback() -> None:
    # A shared entity owned by project B, while the request's ambient project is A.
    project_b = str(uuid.uuid4())
    wb_id = str(uuid.uuid4())
    wb = Whiteboard.model_validate({"id": wb_id, "project_id": project_b})
    await wb.save(None)

    project_a = str(uuid.uuid4())
    resolved = await Conversation.resolve_project_id(
        [f"whiteboard-{wb_id}"], fallback=project_a
    )

    assert resolved == project_b, (
        "conversation must follow the SHARED entity's project (B), not the "
        f"client's ambient project (A); got {resolved!r}"
    )


@pytest.mark.asyncio
async def test_falls_back_when_no_shared_entity_resolves() -> None:
    # Empty / unresolvable shared context → the explicit fallback wins.
    fallback = str(uuid.uuid4())
    assert await Conversation.resolve_project_id([], fallback=fallback) == fallback
    assert await Conversation.resolve_project_id(None, fallback=fallback) == fallback
    # An entity that doesn't exist locally resolves to no project → fallback.
    missing = await Conversation.resolve_project_id(
        [f"whiteboard-{uuid.uuid4()}"], fallback=fallback
    )
    assert missing == fallback


@pytest.mark.asyncio
async def test_entityless_chat_stays_projectless() -> None:
    # No shared entity and no fallback → None (pure cross-user chat is
    # project-less by design; the receiver maps a project only in this case).
    assert await Conversation.resolve_project_id([]) is None
    assert await Conversation.resolve_project_id(None) is None


@pytest.mark.asyncio
async def test_first_resolvable_entity_wins() -> None:
    # An unresolvable ref ahead of a resolvable one must not short-circuit to
    # the fallback — the resolver skips it and keeps scanning.
    project_c = str(uuid.uuid4())
    wb_id = str(uuid.uuid4())
    await Whiteboard.model_validate({"id": wb_id, "project_id": project_c}).save(None)

    resolved = await Conversation.resolve_project_id(
        [f"whiteboard-{uuid.uuid4()}", f"whiteboard-{wb_id}"],
        fallback=str(uuid.uuid4()),
    )
    assert resolved == project_c
