"""Model factories for the Deep Agents runner.

A factory is ``callable(model_slug) -> BaseChatModel``, named on the runner's command line as
``--model-factory module:callable``. Production uses :func:`openai_wire_model`; a test names its
own scripted model through the same argument, so the runner has no test-only branch.
"""

from __future__ import annotations

import os

from flow_sdk.builtin.agentic_process.cli_drivers.deepagents.runner import API_KEY_ENV, BASE_URL_ENV, MAX_OUTPUT_ENV

#: Where an assistant message keeps each tool call's opaque ``extra_content`` (tool call id -> object).
TOOL_CALL_EXTRA = "tool_call_extra"


def _extras_of(raw_tool_calls) -> dict:
    """``{tool call id: extra_content}`` for the raw (wire) tool calls that carry one."""
    out: dict = {}
    for call in raw_tool_calls or ():
        if isinstance(call, dict) and call.get("id") and call.get("extra_content") is not None:
            out[str(call["id"])] = call["extra_content"]
    return out


def _echoing_chat_openai():
    """``ChatOpenAI`` that sends each tool call's ``extra_content`` back with it.

    Gemini (Vertex's OpenAI-compatible surface -- the default allowance's root) signs every
    function call (``extra_content.google.thought_signature``) and answers the next turn 400
    "Function call is missing a thought_signature" unless that object comes back unchanged with the
    call. LangChain keeps only ``id/type/function`` of a tool call, so a deepagents turn that used
    a tool could never finish there. The object is kept on the AIMessage (it survives the session
    checkpoint) and re-attached, by tool call id, to the request.
    """
    from langchain_openai import ChatOpenAI

    class EchoingChatOpenAI(ChatOpenAI):
        def _create_chat_result(self, response, generation_info=None):
            result = super()._create_chat_result(response, generation_info)
            raw = response if isinstance(response, dict) else response.model_dump(warnings=False)
            for generation, choice in zip(result.generations, raw.get("choices") or ()):
                extras = _extras_of(((choice or {}).get("message") or {}).get("tool_calls"))
                if extras:
                    generation.message.additional_kwargs[TOOL_CALL_EXTRA] = extras
            return result

        def _convert_chunk_to_generation_chunk(self, chunk, default_chunk_class, base_generation_info):
            generation = super()._convert_chunk_to_generation_chunk(chunk, default_chunk_class, base_generation_info)
            choices = chunk.get("choices") or (chunk.get("chunk") or {}).get("choices") or []
            if generation is not None and choices:
                extras = _extras_of(((choices[0] or {}).get("delta") or {}).get("tool_calls"))
                if extras:
                    generation.message.additional_kwargs[TOOL_CALL_EXTRA] = extras
            return generation

        def _get_request_payload(self, input_, *, stop=None, **kwargs):
            payload = super()._get_request_payload(input_, stop=stop, **kwargs)
            extras: dict = {}
            for message in self._convert_input(input_).to_messages():
                extras.update(message.additional_kwargs.get(TOOL_CALL_EXTRA) or {})
            if extras:
                for message in payload.get("messages") or ():
                    for call in message.get("tool_calls") or ():
                        extra = extras.get(str(call.get("id") or ""))
                        if extra is not None:
                            call["extra_content"] = extra
            return payload

    return EchoingChatOpenAI


def openai_wire_model(model: str):
    """The chat-completions wire against whatever funds this turn (OpenRouter, a hub endpoint).

    An INSTANCE, never an ``openai:<slug>`` string: deepagents' provider profile forces the
    Responses API for the string form, which a gateway does not speak.
    """
    base_url = os.environ.get(BASE_URL_ENV, "").strip()
    api_key = os.environ.get(API_KEY_ENV, "").strip()
    if not base_url or not api_key:
        raise RuntimeError(
            f"the deepagents worker is funded by an LLM endpoint: {BASE_URL_ENV} and {API_KEY_ENV} must both be set"
        )
    max_tokens = int(os.environ.get(MAX_OUTPUT_ENV, "") or 0) or None
    return _echoing_chat_openai()(
        model=model,
        base_url=base_url,
        api_key=api_key,
        use_responses_api=False,
        stream_usage=True,
        max_tokens=max_tokens,
    )
