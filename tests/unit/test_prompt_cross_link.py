"""``core.entity.cross_link`` — mutual prompt↔process private-context links
(pin-from-history). Live in-memory AP, real DB round-trips, no mocks.
"""
from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.agentic_process import AgenticProcess
from flow_sdk.builtin.prompt import Prompt
from flow_sdk.core.entity.cross_link import (
    cross_link_entities,
    uncross_link_entities,
)
from flow_sdk.flowpad_types.enums import WorkerType

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def _save_prompt(text: str = "Do the thing.") -> Prompt:
    return await Prompt(name="Pinned", text=text).save()


async def _save_ap() -> AgenticProcess:
    return await AgenticProcess(
        id=str(uuid.uuid4()),
        session_id=str(uuid.uuid4()),
        worker_type=WorkerType.CLAUDE_CODE,
    ).save()


def _has_link(entries, type_, id_) -> bool:
    return any(t.type == type_ and t.id == id_ for t in entries)


@pytest.mark.asyncio
async def test_cross_link_both_directions_persisted(initialize_test_db) -> None:
    prompt = await _save_prompt()
    ap = await _save_ap()

    changed = await cross_link_entities(prompt, ap)
    assert changed is True

    # In-memory instances carry the links immediately.
    assert _has_link(prompt.private_context_entities_, AgenticProcess.get_type(), ap.id)
    assert _has_link(ap.private_context_entities_, Prompt.get_type(), prompt.id)

    prompt_reloaded = await Prompt.get_by_id(prompt.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert _has_link(prompt_reloaded.private_context_entities_, AgenticProcess.get_type(), ap.id)
    assert _has_link(ap_reloaded.private_context_entities_, Prompt.get_type(), prompt.id)


@pytest.mark.asyncio
async def test_cross_link_idempotent(initialize_test_db) -> None:
    prompt = await _save_prompt("Twice.")
    ap = await _save_ap()

    assert await cross_link_entities(prompt, ap) is True
    assert await cross_link_entities(prompt, ap) is False  # no change

    prompt_reloaded = await Prompt.get_by_id(prompt.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert sum(1 for t in prompt_reloaded.private_context_entities_ if t.id == ap.id) == 1
    assert sum(1 for t in ap_reloaded.private_context_entities_ if t.id == prompt.id) == 1


@pytest.mark.asyncio
async def test_remove_link_both_directions(initialize_test_db) -> None:
    prompt = await _save_prompt("Gone.")
    ap = await _save_ap()
    await cross_link_entities(prompt, ap)

    assert await uncross_link_entities(prompt, ap) is True
    assert await uncross_link_entities(prompt, ap) is False  # already gone

    prompt_reloaded = await Prompt.get_by_id(prompt.id)
    ap_reloaded = await AgenticProcess.get_by_id(ap.id)
    assert not _has_link(prompt_reloaded.private_context_entities_, AgenticProcess.get_type(), ap.id)
    assert not _has_link(ap_reloaded.private_context_entities_, Prompt.get_type(), prompt.id)
