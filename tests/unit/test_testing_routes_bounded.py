"""The test/debug observation buffers behind ``/ping`` and ``/prompt`` are bounded.

The routes are mounted in the production app and the shipped CLI (``flow ping``,
``flow prompt``) writes to them, but nothing in production ever reads the
buffers -- so unbounded lists leaked one dict per call for the life of the
backend (5.6 MB after 10,000 calls each, 751 KB per ``/get_pings`` body).
They are most-recent-N rings now; the getters must snapshot them as lists,
because a deque is not JSON-serialisable and forgetting that is a 500.
"""

from __future__ import annotations

import httpx
import pytest
from fastapi import FastAPI

from flow_sdk.server import state
from flow_sdk.server.routes import testing

pytestmark = pytest.mark.asyncio


@pytest.fixture(autouse=True)
def _empty_buffers():
    state.ping_results.clear()
    state.prompt_completions.clear()
    yield
    state.ping_results.clear()
    state.prompt_completions.clear()


async def test_the_buffers_keep_only_the_most_recent_entries():
    app = FastAPI()
    app.include_router(testing.router)
    n = state.TEST_ROUTE_BUFFER_CAP + 50
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://t") as c:
        for i in range(1, n + 1):
            assert (await c.get("/ping", params={"ping_str": f"p{i}"})).status_code == 200
            assert (await c.get("/prompt", params={"prompt_text": f"q{i}"})).status_code == 200
        pings = await c.get("/get_pings")
        prompts = await c.get("/get_prompts")

    assert len(state.ping_results) == state.TEST_ROUTE_BUFFER_CAP
    assert len(state.prompt_completions) == state.TEST_ROUTE_BUFFER_CAP
    assert pings.status_code == 200 and prompts.status_code == 200
    assert len(pings.json()["pings"]) == state.TEST_ROUTE_BUFFER_CAP
    assert len(prompts.json()["prompts"]) == state.TEST_ROUTE_BUFFER_CAP
    assert pings.json()["pings"][-1]["ping_str"] == f"p{n}"
    assert prompts.json()["prompts"][-1]["prompt_text"] == f"q{n}"
