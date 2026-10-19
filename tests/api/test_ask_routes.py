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


async def test_a_process_that_is_not_the_backend_asks_through_it(client, monkeypatch, tmp_path):
    """The whole cross-process path over the real route: the asker holds nothing,
    the backend raises and holds the question, the person answers through the
    usual route, and the typed value comes back — with the lease held until then."""
    import sys
    from contextlib import asynccontextmanager
    from pathlib import Path
    from types import SimpleNamespace
    from typing import ClassVar

    from flow_sdk.core.compute_op import ask, run_op
    from flow_sdk.core.connections import service
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode
    from flow_sdk.schema.data_spec.spec import DataSpec

    class CrossToken(DataSpec):
        spec_kind: ClassVar[str] = "test.ask.cross_token"
        token: str

    monkeypatch.setenv("FLOWPAD_NO_BROWSER", "1")
    monkeypatch.setattr(ask, "_SERVED_HERE", False)  # the asker plays a script, not the backend
    lease_open: list[bool] = []

    class Client:
        async def request(self, method, path, json=None):
            said = await client.request(method, path, json=json)
            body = said.json()
            return service.LocalResponse(status=said.status_code, success=body.get("status") == "SUCCESS",
                                         data=body.get("data"), message=body.get("message"))

    @asynccontextmanager
    async def backend():
        lease_open.append(True)
        yield SimpleNamespace(client=Client())
        lease_open.append(False)

    monkeypatch.setattr(service, "flow_service", backend)
    spec = ComputeOpSpec.model_validate({
        "name": "get-api-key", "label": "API token", "subkind": "ask",
        "exe_data": {"prompt": "Service X API token"},
        "completion_check": {"commands": {sys.platform: f"cat {tmp_path / 'token'}"}},
        "output_spec_kind": "test.ask.cross_token",
    })
    running = asyncio.create_task(
        run_op(spec, trusted=True, workdir=Path(tmp_path), platform=sys.platform, ask_timeout=5)
    )
    for _ in range(200):
        listed = (await client.get("/api/v1/ask")).json()["data"]["questions"]
        if listed:
            break
        await asyncio.sleep(0.01)
    else:
        raise AssertionError("the backend never raised the question")
    assert lease_open == [True], "the lease must stay held while the person answers"

    sent = await client.post(f"/api/v1/ask/{listed[0]['id']}/answer", json={"value": {"token": "sk-cross"}})
    assert sent.status_code == 200
    said = await running

    assert said.exit_code is ExitCode.OK and said.value.token == "sk-cross"
    assert lease_open == [True, False]
