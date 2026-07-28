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


@pytest.mark.asyncio
async def test_conversation_binding_ignores_on_disk_recovery(tmp_path, monkeypatch) -> None:
    """Binding a conversation to a project must never consult the filesystem.

    ``ClaudeSession.get_by_id`` recovers an unindexed session from disk, which is
    right for display-time healing but wrong for a durable decision: a shared
    session has NO row yet when its conversation is materialized, and on a
    machine where two instances share a home dir the id-keyed scan returns the
    SENDER's transcript. That bound the receiver's conversation to a project
    derived from the sender's file, which (per the reception model) counts as
    install consent and skipped both the pick-a-project and review dialogs.
    """
    from flow_sdk.builtin.claude_session import ClaudeSession as CS

    eid = str(uuid.uuid4())
    recovered_project = str(uuid.uuid4())

    # No row exists — only a "transcript on disk" the recovery would find.
    assert await CS.get_one({"id": eid}) is None
    monkeypatch.setattr(
        CS,
        "_recover_from_disk",
        classmethod(lambda cls, e: cls(id=e, project_id=recovered_project)),
    )

    # Display-time path still heals from disk (the lens/tab project mint).
    assert await Entity.project_id_of("claude_session", eid) == recovered_project

    # The conversation resolver must NOT: it reads DB rows only, so an
    # uninstalled shared session leaves the conversation unbound.
    assert await Conversation.resolve_project_id([f"claude_session-{eid}"]) is None


@pytest.mark.asyncio
async def test_staged_session_does_not_recover_from_disk(monkeypatch) -> None:
    """A session that arrived on a message must not be invented from disk.

    The receiver's DB has no row until the user installs it, so every lookup
    (the chip's "do I have this?", the lens' project) fell through to the
    id-keyed disk scan and got the SENDER's transcript back. That made the chip
    render solid instead of dashed — skipping the review dialog entirely — and
    opened the lens in the sender's project.
    """
    from flow_sdk.builtin.claude_session import ClaudeSession as CS
    from flow_sdk.builtin.message_attachment import MessageAttachment

    eid = str(uuid.uuid4())
    monkeypatch.setattr(
        CS, "_recover_from_disk", classmethod(lambda cls, e: cls(id=e, project_id="sender-project"))
    )

    # No attachment yet → a LOCAL un-indexed session still heals (lens/tab mint).
    assert (await CS.get_by_id(eid)) is not None

    # Staged from a message → refuse, so the chip stays dashed.
    ma = MessageAttachment.model_validate(
        {"id": str(uuid.uuid4()), "asset_type": "claude_session", "asset_id": eid}
    )
    await ma.save(None)
    assert not ma.installed
    assert (await CS.get_by_id(eid)) is None

    # Installed → the real row answers first; recovery is never consulted.
    real = CS.model_validate({"id": eid, "received": True})
    await real.save(None)
    got = await CS.get_by_id(eid)
    assert got is not None and got.project_id != "sender-project"
