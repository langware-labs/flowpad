"""``Entity.project_id_of`` — parent-chain fallback.

A child entity with no ``project_id`` of its own (e.g. a RECEIVED claude
session, materialized from a shared message with no local cwd) must resolve
its owning project through its ``parent_type_id`` chain — the conversation it
was shared into, or any further ancestor that carries a project. Without the
fallback such an entity resolves to no project, so its transcript lens / tab
lands in the Global scope even when its conversation is mapped to a project.

Own ``project_id`` always wins; the walk is generic (any parent type), stops
on a missing parent, and is cycle-safe.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.claude_session import ClaudeSession
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.whiteboard import Whiteboard
from flow_sdk.core import Entity


@pytest.mark.asyncio
async def test_received_session_inherits_parent_conversation_project() -> None:
    # The reported bug: a received transcript's session row has no project_id
    # and no cwd, but is parented to a conversation that has a project.
    project = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": str(uuid.uuid4()), "project_id": project})
    await conv.save(None)

    sess = ClaudeSession.model_validate(
        {"id": str(uuid.uuid4()), "received": True, "parent_type_id": f"conversation-{conv.id}"}
    )
    await sess.save(None)

    resolved = await Entity.project_id_of("claude_session", sess.id)
    assert resolved == project, (
        "a project-less child must inherit its parent conversation's project; "
        f"got {resolved!r}"
    )


@pytest.mark.asyncio
async def test_own_project_wins_over_parent() -> None:
    parent_project = str(uuid.uuid4())
    own_project = str(uuid.uuid4())
    conv = Conversation.model_validate({"id": str(uuid.uuid4()), "project_id": parent_project})
    await conv.save(None)
    sess = ClaudeSession.model_validate(
        {"id": str(uuid.uuid4()), "project_id": own_project, "parent_type_id": f"conversation-{conv.id}"}
    )
    await sess.save(None)

    assert await Entity.project_id_of("claude_session", sess.id) == own_project


@pytest.mark.asyncio
async def test_walk_spans_multiple_hops_generically() -> None:
    # Grandparent carries the project; the middle ancestor is project-less.
    # Uses a non-conversation ancestor to prove the walk is type-generic.
    project = str(uuid.uuid4())
    wb = Whiteboard.model_validate({"id": str(uuid.uuid4()), "project_id": project})
    await wb.save(None)
    conv = Conversation.model_validate(
        {"id": str(uuid.uuid4()), "parent_type_id": f"whiteboard-{wb.id}"}
    )
    await conv.save(None)
    sess = ClaudeSession.model_validate(
        {"id": str(uuid.uuid4()), "parent_type_id": f"conversation-{conv.id}"}
    )
    await sess.save(None)

    assert await Entity.project_id_of("claude_session", sess.id) == project


@pytest.mark.asyncio
async def test_missing_parent_and_projectless_chain_resolve_none() -> None:
    # Parent ref points at an entity that has no local row (e.g. the sender's
    # agentic_process): the walk stops and the entity stays project-less.
    dangling = ClaudeSession.model_validate(
        {"id": str(uuid.uuid4()), "parent_type_id": f"conversation-{uuid.uuid4()}"}
    )
    await dangling.save(None)
    assert await Entity.project_id_of("claude_session", dangling.id) is None

    # A resolvable but project-less chain also yields None (Global by design).
    conv = Conversation.model_validate({"id": str(uuid.uuid4())})
    await conv.save(None)
    sess = ClaudeSession.model_validate(
        {"id": str(uuid.uuid4()), "parent_type_id": f"conversation-{conv.id}"}
    )
    await sess.save(None)
    assert await Entity.project_id_of("claude_session", sess.id) is None


@pytest.mark.asyncio
async def test_parent_cycle_terminates() -> None:
    # A ↔ B parent cycle, neither owning a project: must return None, not hang.
    a_id, b_id = str(uuid.uuid4()), str(uuid.uuid4())
    a = Conversation.model_validate({"id": a_id, "parent_type_id": f"conversation-{b_id}"})
    b = Conversation.model_validate({"id": b_id, "parent_type_id": f"conversation-{a_id}"})
    await a.save(None)
    await b.save(None)

    assert await Entity.project_id_of("conversation", a_id) is None
