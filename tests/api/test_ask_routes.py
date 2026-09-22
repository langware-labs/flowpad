"""The three ask routes, over the real ASGI app — no mocks, no browser.

This is the half the window talks to: read the question, answer it, or decline.
A browser test proves the window; this proves the contract underneath it, which
is what makes a failure up there readable.
"""
from __future__ import annotations

import asyncio

import pytest

from flow_sdk.core.compute_op.ask import open_question, wait_for

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval


async def test_a_question_can_be_read_and_answered(client):
    question = open_question("get-api-key", "Service X API token", {"token": "string"})
    waiting = asyncio.create_task(wait_for(question, timeout=5))

    got = await client.get(f"/api/v1/ask/{question.id}")
    assert got.status_code == 200
    assert got.json()["data"]["prompt"] == "Service X API token"
    assert got.json()["data"]["fields"] == {"token": "string"}, "what the window draws"

    sent = await client.post(f"/api/v1/ask/{question.id}/answer",
                             json={"value": {"token": "sk-live-1"}})
    assert sent.status_code == 200
    assert (await waiting).token == "sk-live-1", "the answer arrives TYPED, not as a dict"


async def test_an_answer_of_the_wrong_shape_is_correctable(client):
    """422, and the question stays open so the person can try again."""
    question = open_question("get-api-key", "token", {"token": "string"})
    waiting = asyncio.create_task(wait_for(question, timeout=5))

    bad = await client.post(f"/api/v1/ask/{question.id}/answer", json={"value": {"token": 7}})
    assert bad.status_code == 422

    still_there = await client.get(f"/api/v1/ask/{question.id}")
    assert still_there.status_code == 200, "a wrong answer must not close the question"

    await client.post(f"/api/v1/ask/{question.id}/answer", json={"value": {"token": "ok"}})
    assert (await waiting).token == "ok"


async def test_cancelling_ends_the_wait_without_a_value(client):
    from flow_sdk.core.compute_op.ask import Cancelled

    question = open_question("get-api-key", "token", {"token": "string"})
    waiting = asyncio.create_task(wait_for(question, timeout=5))

    done = await client.post(f"/api/v1/ask/{question.id}/cancel")
    assert done.status_code == 200
    with pytest.raises(Cancelled):
        await waiting


async def test_a_settled_question_is_gone_rather_than_pending(client):
    """404 is the normal end state — the window shows it instead of spinning."""
    question = open_question("get-api-key", "token", {"token": "string"})
    waiting = asyncio.create_task(wait_for(question, timeout=0.1))
    with pytest.raises((TimeoutError, asyncio.TimeoutError)):
        await waiting

    assert (await client.get(f"/api/v1/ask/{question.id}")).status_code == 404
    assert (await client.post(f"/api/v1/ask/{question.id}/answer",
                              json={"value": {"token": "late"}})).status_code == 404
    assert (await client.post(f"/api/v1/ask/{question.id}/cancel")).status_code == 404
