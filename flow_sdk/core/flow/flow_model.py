from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
from enum import Enum
from typing import AsyncIterator

from openai import AsyncStream
from openai.types.chat import ChatCompletionChunk
from pydantic_ai import UnexpectedModelBehavior, _utils
from pydantic_ai.messages import ModelResponseStreamEvent
from pydantic_ai.models import ModelRequestParameters
from pydantic_ai.models.anthropic import AnthropicModel
from pydantic_ai.models.fallback import FallbackModel
from pydantic_ai.models.openai import OpenAIChatModel, OpenAIStreamedResponse, _map_usage
from pydantic_ai.providers.anthropic import AnthropicProvider
from pydantic_ai.providers.openai import OpenAIProvider
from pydantic_ai.settings import ModelSettings

from flow_sdk.config import default_service_config


class FlowURLs(str, Enum):
    OPENROUTER_API = "https://openrouter.ai/api/v1"
    OPENAI_API = "https://api.openai.com/v1"


@dataclass(init=False)
class FlowModel(FallbackModel):
    """
    This model overrides the FallbackModel to allow for different model settings for each model.
    """

    def __init__(self, model: str | None = None):
        default_model = FlowOpenAIModel(
            model or "anthropic/claude-sonnet-4.5",
            provider=OpenAIProvider(
                base_url=FlowURLs.OPENROUTER_API,
                api_key=default_service_config.openrouter_api_key,
            ),
            settings=ModelSettings(
                max_tokens=64000,
                extra_body={"reasoning": {"effort": "high"}, "transforms": ["middle-out"]},
            ),
        )
        fallback_models = [
            AnthropicModel(
                "claude-sonnet-4-5-20250929",
                provider=AnthropicProvider(
                    api_key=default_service_config.anthropic_api_key,
                ),
                settings=ModelSettings(
                    max_tokens=64000,
                    extra_body={"thinking": {"type": "enabled", "budget_tokens": 51200}},
                ),
            ),
            # TODO [FLOWPAD-1016] Increase bedrock token limit
            # BedrockConverseModel(
            #     "us.anthropic.claude-sonnet-4-20250514-v1:0",
            #     provider=BedrockProvider(
            #         region_name=default_service_config.bedrock_aws_region_name,
            #         aws_access_key_id=default_service_config.bedrock_aws_access_key_id,
            #         aws_secret_access_key=default_service_config.bedrock_aws_secret_access_key,
            #     ),
            # ),
            FlowOpenAIModel(
                "anthropic/claude-sonnet-4",
                provider=OpenAIProvider(
                    base_url=FlowURLs.OPENROUTER_API,
                    api_key=default_service_config.openrouter_api_key,
                ),
                settings=ModelSettings(
                    max_tokens=64000,
                    extra_body={"reasoning": {"effort": "high"}, "transforms": ["middle-out"]},
                ),
            ),
        ]
        super().__init__(default_model, *fallback_models)


@dataclass(init=False)
class FlowOpenAIModel(OpenAIChatModel):
    """
    This is a temporary hack to get the openrouter models to export reasoning tokens.
    This should be removed once pydantic-ai supports reasoning tokens:
    https://github.com/pydantic/pydantic-ai/pull/1142
    """

    async def _process_streamed_response(
        self, response: AsyncStream[ChatCompletionChunk], model_request_parameters: ModelRequestParameters
    ) -> OpenAIStreamedResponse:
        """Process a streamed response, and prepare a streaming response to return."""
        peekable_response = _utils.PeekableAsyncStream(response)
        first_chunk = await peekable_response.peek()
        if isinstance(first_chunk, _utils.Unset):
            raise UnexpectedModelBehavior(  # pragma: no cover
                "Streamed response ended without content or tool calls"
            )

        # Get provider URL from the provider's base_url
        provider_url = getattr(self._provider, "base_url", None) or FlowURLs.OPENAI_API

        return FlowModelStreamedResponse(
            model_request_parameters=model_request_parameters,
            _model_name=self._model_name,
            _model_profile=self.profile,
            _response=peekable_response,
            _timestamp=datetime.fromtimestamp(first_chunk.created, tz=timezone.utc),
            _provider_name="openai",
            _provider_url=provider_url,
        )


@dataclass
class FlowModelStreamedResponse(OpenAIStreamedResponse):
    _reasoning_started: bool = False

    async def _get_event_iterator(self) -> AsyncIterator[ModelResponseStreamEvent]:
        async for chunk in self._response:
            self._usage += _map_usage(chunk, self._provider_name, self._provider_url, self._model_name)

            try:
                choice = chunk.choices[0]
            except IndexError:
                continue

            # Handle the text part of the response
            content = choice.delta.content
            if content:
                maybe_event = self._parts_manager.handle_text_delta(
                    vendor_part_id="content",
                    content=content,
                    thinking_tags=self._model_profile.thinking_tags,
                    ignore_leading_whitespace=self._model_profile.ignore_streamed_leading_whitespace,
                )
                if maybe_event is not None:  # pragma: no branch
                    yield maybe_event

            # Handle reasoning part of the response, present in DeepSeek models
            if reasoning_content := getattr(choice.delta, "reasoning_content", None):
                yield self._parts_manager.handle_thinking_delta(
                    vendor_part_id="reasoning_content", content=reasoning_content
                )

            # Handle reasoning part of the response, present in OpenRouter models
            if reasoning := choice.delta.model_extra.get("reasoning", None) if choice.delta.model_extra else None:
                yield self._parts_manager.handle_thinking_delta(vendor_part_id="reasoning", content=reasoning)

            for dtc in choice.delta.tool_calls or []:
                maybe_event = self._parts_manager.handle_tool_call_delta(
                    vendor_part_id=dtc.index,
                    tool_name=dtc.function and dtc.function.name,
                    args=dtc.function and dtc.function.arguments,
                    tool_call_id=dtc.id,
                )
                if maybe_event is not None:
                    yield maybe_event
