"""A scripted chat model for the Deep Agents runner — named on its command line as
``--model-factory tests.utils.deepagents_fake_model:scripted``, the same seam production uses for
its real model, so the runner has no test-only branch.

The script is a JSON file (path in ``DEEPAGENTS_FAKE_SCRIPT``): a list of turns, each either
``{"text": "..."}`` or ``{"tool_calls": [{"name": ..., "args": {...}}]}``, optionally with a
``"finish_reason"`` (an empty turn with one is how an upstream failure arrives inside a 200). The model replays them
in order, one per invocation, which drives deepagents' real tool loop with no LLM.
"""

from __future__ import annotations

import json
import os
from pathlib import Path
from typing import Any

from langchain_core.language_models.fake_chat_models import FakeMessagesListChatModel
from langchain_core.messages import AIMessage


class ScriptedChatModel(FakeMessagesListChatModel):
    """``FakeMessagesListChatModel`` does not implement ``bind_tools``; ``create_agent`` binds
    tools unconditionally, so the scripted model accepts the binding and ignores it."""

    def bind_tools(self, tools: Any, **kwargs: Any) -> "ScriptedChatModel":
        return self


class OpenAIInvalidRequestError(RuntimeError):
    """Same class NAME as the real OpenAI client's — ``runner._error_kind`` classifies on it —
    so a test raising this exercises the same ``kind="model"`` branch production hits."""


class RejectingChatModel(ScriptedChatModel):
    """Raises on every call, exactly the shape a gateway sends for a model an endpoint's chain
    refuses (``OpenAIInvalidRequestError: ... 'model X not allowed by endpoint Y budget'``) —
    proves the runner's fallback-and-retry, not the real gateway's wire format. Built fresh once
    per model-factory call (see ``run_turn``'s retry loop), so "every call" and "the first call"
    are the same thing here: the run never invokes the SAME rejected model twice."""

    def _generate(self, *args: Any, **kwargs: Any):  # noqa: ANN001, ANN201, D102
        raise OpenAIInvalidRequestError("Error code: 400 - model rejected-model not allowed by endpoint Test budget")


def _scripted_responses() -> list[AIMessage]:
    turns = json.loads(Path(os.environ["DEEPAGENTS_FAKE_SCRIPT"]).read_text(encoding="utf-8"))
    responses = []
    for index, turn in enumerate(turns):
        calls = [
            {
                "name": call["name"],
                "args": call.get("args") or {},
                "id": call.get("id") or f"call_{index}_{n}",
                "type": "tool_call",
            }
            for n, call in enumerate(turn.get("tool_calls") or [])
        ]
        responses.append(
            AIMessage(
                content=turn.get("text") or "",
                tool_calls=calls,
                usage_metadata={"input_tokens": 10, "output_tokens": 5, "total_tokens": 15},
                response_metadata={"finish_reason": turn["finish_reason"]} if "finish_reason" in turn else {},
            )
        )
    return responses


def scripted(model: str) -> ScriptedChatModel:
    return ScriptedChatModel(responses=_scripted_responses())


def scripted_rejecting(model: str) -> ScriptedChatModel:
    """Like :func:`scripted`, except the model named ``rejected-model`` raises instead of
    answering — the runner's fallback-and-retry (``_fallback_model``/``_model_rejected`` in
    ``deepagents/runner.py``) is what is meant to get past it and complete the script on
    whatever model it retries with."""
    if model == "rejected-model":
        return RejectingChatModel(responses=[])
    return ScriptedChatModel(responses=_scripted_responses())
