"""The long-tier fences of ``docs/snippets/call-returns.md``, run as written.

§9 (an agent names its process, and a caller continues it) needs a real agent
harness; §10 (a model, no tools) needs an API-capable LLM source on this box.
Same rules as the fast tier (``tests/unit/test_call_returns_snippets.py``):
each fence runs literally and every ``# expected`` line is asserted.

Requires DEEP_TESTING=true, the worker CLI on PATH with real ``$HOME``
credentials (this module is in ``_REAL_HOME_TEST_MODULES``), and for §10 a box
LLM source that can answer an API call — skipped, never provisioned, without one.
"""
from __future__ import annotations

import textwrap

import pytest

from flow_sdk.core.compute_op import runner
from tests.test_settings import test_service_config
from tests.unit.test_call_returns_snippets import LONG_TIER, _scope, fences, with_assertions

pytestmark = [
    pytest.mark.skipif(not test_service_config.deep_testing, reason="Skipping long tests when DEEP_TESTING is disabled"),
]

LIVE = [f for f in fences("python") if f.lstrip().startswith(LONG_TIER)]


def test_the_page_has_its_live_fences():
    assert len(LIVE) == 2


async def _skip_unless_the_box_can_answer_a_prompt() -> None:
    """§10 needs an API-capable LLM source ALREADY configured on this box.

    Never stored from here: with the real ``$HOME`` this module runs under, the
    secret store is the real instance's, and a test must not write a key into it.
    """
    if await runner._box_llm() is None:
        pytest.skip("this box has no API-capable LLM source (only a signed-in vendor CLI) to answer §10")


@pytest.mark.parametrize("index", range(len(LIVE)), ids=["agent-executor", "prompt"])
@pytest.mark.asyncio
async def test_every_live_fence_runs_as_written(index, tmp_path, bootstrapped_client):
    if "subkind=\"prompt\"" in LIVE[index]:
        await _skip_unless_the_box_can_answer_a_prompt()
    body, asserted = with_assertions(LIVE[index])
    assert asserted
    scope = _scope(tmp_path)
    exec("async def __fence():\n" + textwrap.indent(body, "    "), scope)
    await scope["__fence"]()


@pytest.mark.asyncio
async def test_a_prompt_op_answers_through_a_real_endpoint(tmp_path, monkeypatch):
    """The prompt subkind end to end against a real model, when a key is in the
    environment. Only the box's source SELECTION is substituted — the endpoint
    reads its key from the environment, exactly as ``LLMEndpoint(provider=...)``
    does with nothing stored — so nothing is written to any secret store."""
    import os

    from flow_sdk.builtin.llm_endpoint import LLMEndpoint
    from flow_sdk.schema.data_spec.compute_op_spec import ComputeOpSpec, PromptOp
    from flow_sdk.schema.data_spec.returned_value_spec import ExitCode, PromptResult

    if not os.environ.get("OPENROUTER_API_KEY"):
        pytest.skip("OPENROUTER_API_KEY is not set")
    endpoint = LLMEndpoint(provider="openrouter")

    async def this_endpoint():
        return endpoint

    monkeypatch.setattr(runner, "_box_llm", this_endpoint)
    op = ComputeOpSpec(name="pong", subkind="prompt", exe_data=PromptOp(prompt="Say the single word: pong"))
    answer = await runner.run_op(op, trusted=True, workdir=tmp_path)
    assert type(answer) is PromptResult
    assert answer.exit_code is ExitCode.OK, answer.detail
    assert "pong" in answer.text.lower()
