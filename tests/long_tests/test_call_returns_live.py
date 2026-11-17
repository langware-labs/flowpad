"""The long-tier fences of ``docs/snippets/call-returns.md``, run as written.

§9 (an agent names its process, and a caller continues it) needs a real agent
harness; §10 (a model, no tools) needs an API-capable LLM source on this box.
Same rules as the fast tier (``tests/unit/test_call_returns_snippets.py``):
each fence runs literally and every ``# expected`` line is asserted.

Requires DEEP_TESTING=true, the worker CLI on PATH with real ``$HOME``
credentials (this module is in ``_REAL_HOME_TEST_MODULES``), and for §10 a box
LLM source that can answer an API call. That source is the one a new Flowpad user's box
has: a LOCAL hub (``FLOWPAD_HUB_URL``) signed in as a brand-new user, whose default
allowance draws on the hub's Vertex-funded root. No provider key is read or stored.
"""
from __future__ import annotations

import textwrap

import pytest

from flow_sdk.core.compute_op import runner
from tests.test_settings import test_service_config
from tests.unit.test_call_returns_snippets import LONG_TIER, _scope, fences, with_assertions
from tests.utils.snippets import record_run

pytestmark = [
    pytest.mark.skipif(not test_service_config.deep_testing, reason="Skipping long tests when DEEP_TESTING is disabled"),
]

LIVE = [f for f in fences("python") if f.lstrip().startswith(LONG_TIER)]


def test_the_page_has_its_live_fences():
    assert len(LIVE) == 2


async def _sign_in_to_a_vertex_funded_hub() -> None:
    """Give this box the LLM source a new user's box has: a hub allowance, or SKIP.

    The login lands in the pytest sandbox (``_real_home_for_cli_subprocess_tests`` pins
    ``FLOW_HOME`` there) -- never the real instance's store -- and no key is stored at all.
    """
    from flow_sdk.cloud_client.hub_proxy import HubProxy
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints
    from tests.long_tests.conftest import _sign_in_to_the_local_hub

    await _sign_in_to_the_local_hub("prompt op")
    await HubProxy.try_call("GET", "bootstrap")  # mints the default allowance on first contact
    if not await fetch_hub_llm_endpoints():
        pytest.skip("the local hub offered this box no LLM endpoint to spend")


async def _fund_the_box_for_a_prompt() -> None:
    """§10 needs an API-capable LLM source on this box: the hub allowance above. Once the
    hub has given this box one, the box's own selection must find it -- not a skip."""
    await _sign_in_to_a_vertex_funded_hub()
    assert await runner._box_llm() is not None, (
        "signed in to a hub that offers this box an endpoint, yet the box found no API-capable LLM source for §10"
    )


@pytest.mark.parametrize("index", range(len(LIVE)), ids=["agent-executor", "prompt"])
@pytest.mark.asyncio
async def test_every_live_fence_runs_as_written(index, tmp_path, bootstrapped_client):
    if "subkind=\"prompt\"" in LIVE[index]:
        await _fund_the_box_for_a_prompt()
    body, asserted = with_assertions(LIVE[index])
    assert asserted
    scope = _scope(tmp_path)
    exec("async def __fence():\n" + textwrap.indent(body, "    "), scope)
    await scope["__fence"]()
    record_run(LIVE[index])


@pytest.mark.asyncio
async def test_a_prompt_op_answers_through_a_real_endpoint(tmp_path, monkeypatch):
    """The prompt subkind end to end against a real model, through a hub endpoint:
    a new user's default allowance on the LOCAL hub, funded by its Vertex root. Only
    the box's source SELECTION is substituted — the endpoint is the hub's own row,
    spent with this box's hub login — so nothing is written to any secret store."""
    from flow_sdk.instance_settings.llm_endpoint import fetch_hub_llm_endpoints
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, PromptOp
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

    await _sign_in_to_a_vertex_funded_hub()
    endpoint = (await fetch_hub_llm_endpoints())[0]

    async def this_endpoint():
        return endpoint

    monkeypatch.setattr(runner, "_box_llm", this_endpoint)
    op = ComputeOpSpec(name="pong", subkind="prompt", exe_data=PromptOp(prompt="Say the single word: pong"))
    answer = await runner.run_op(op, trusted=True, workdir=tmp_path)
    assert type(answer) is PromptResult
    assert answer.exit_code is ExitCode.OK, answer.detail
    assert "pong" in answer.text.lower()
