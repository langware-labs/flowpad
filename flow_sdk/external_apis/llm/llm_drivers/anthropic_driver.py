import logging
import time
from typing import List, Literal, Optional

from anthropic import NotGiven
from anthropic.lib.vertex import AsyncAnthropicVertex
from anthropic.types import MessageParam

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMMessage, LLMModelInfo, LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_base_driver import LLMDriver
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler
from flow_sdk.utils import count_tokens


def transform_to_claude(messages: List[LLMMessage]) -> List[MessageParam]:
    messages_claude: List[MessageParam] = []

    def add_empty_message(role: Literal["user", "assistant"]):
        # Claude can't handle empty messages, so we add a placeholder
        messages_claude.append({"role": role, "content": "<empty>"})

    for message in messages:
        if message.role == "system":
            raise ValueError("System messages should not be present at this stage")
        elif message.role == "assistant":
            if messages_claude and messages_claude[-1]["role"] == "assistant":
                add_empty_message("user")
        else:
            if messages_claude and messages_claude[-1]["role"] == "user":
                add_empty_message("assistant")
        messages_claude.append({"role": message.role, "content": message.content.strip()})

    return messages_claude


class AnthropicDriver(LLMDriver):
    provider: LLMProvider = LLMProvider.Anthropic

    def __init__(self):
        self.client = AsyncAnthropicVertex(
            project_id=default_service_config.google_cloud_project_id,
            region=default_service_config.google_anthropic_cloud_project_location,
        )

    @classmethod
    def supported_models(cls) -> List[LLMModelInfo]:
        return [
            LLMModelInfo(
                name="claude-3-5-sonnet-v2@20241022",
                max_input_tokens=200000,
                max_output_tokens=8000,
                provider=cls.provider,
            ),
            LLMModelInfo(
                name="claude-3-5-sonnet@20240620", max_input_tokens=4096, max_output_tokens=8192, provider=cls.provider
            ),
            LLMModelInfo(
                name="claude-3-7-sonnet@20250219",
                max_input_tokens=200000,
                max_output_tokens=8000,
                provider=cls.provider,
            ),
        ]

    async def generate(
        self,
        messages: List[LLMMessage],
        model: str,
        stop: List[str] | None = None,
        temperature: Optional[float] = 0,
        json_output: bool = False,
        callback_handler: Optional[CallbackHandler] = None,
        verbose: bool = False,
    ) -> LLMResponse:
        try:
            t0 = time.time()
            # Only using the last system message as the system prompt
            system_prompt = next((m for m in reversed(messages) if m.role == "system"), None)
            filtered_messages = [m for m in messages if m.role != "system"]
            for m in filtered_messages:
                if m.role != "user":
                    m.role = "assistant"
            claude_messages = transform_to_claude(filtered_messages)
            partial_message = ""
            async with self.client.messages.stream(
                # 8192 output tokens is in beta and requires the header:
                # anthropic-beta: max-tokens-3-5-sonnet-2024-07-15
                # If the header is not specified, the limit is 4096 tokens.
                max_tokens=4096,
                model=model,
                system=system_prompt.content if system_prompt is not None else NotGiven(),
                messages=claude_messages,
                temperature=temperature if temperature is not None else NotGiven(),
                stop_sequences=stop if stop is not None else NotGiven(),
                # response_format={"type": "json_object"},
            ) as response_stream:
                last_chunk = None
                first_token_time = 0.0
                async for chunk in response_stream:
                    if last_chunk is None:
                        first_token_time = time.time() - t0
                        if verbose:
                            logging.info(f"Time until first llm token: {first_token_time:.2f}s")
                    last_chunk = chunk

                    if chunk.type == "content_block_delta" and chunk.delta.type == "text_delta" and chunk.delta.text:
                        partial_message += chunk.delta.text
                        if callback_handler:
                            await callback_handler.on_new_chunk(chunk.delta.text)
            if last_chunk is None:
                raise ValueError("No response from Claude")
            full_message = partial_message
            if last_chunk.type == "message_stop":
                completion_tokens = last_chunk.message.usage.output_tokens
            else:
                logging.warning(f"Last chunk is not a message stop event {last_chunk}")
                completion_tokens = await count_tokens(full_message.split())
            t1 = time.time()
            if verbose:
                logging.info(f"Time until last llm response: {t1 - t0:.2f}s")
                logging.info(f"Completion tokens: {completion_tokens}")

            if callback_handler:
                await callback_handler.on_llm_end()

            return LLMResponse(
                messages=messages,
                completion=full_message,
                generation_time=t1 - t0,
                first_token_time=first_token_time,
                completion_tokens=completion_tokens,
            )
        except Exception as e:
            if callback_handler is not None:
                await callback_handler.on_error(e)
            logging.error(f"Error in Claude completion: {e}")
            raise
