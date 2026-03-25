import asyncio
import json
import logging
from typing import AsyncGenerator

from openai import AsyncOpenAI
from openai.types.chat import ChatCompletionSystemMessageParam, ChatCompletionUserMessageParam

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm.utils.utils import clean_fenced_completion


async def openrouter_completion(
    instruction: str,
    content: str,
    stream: bool = False,
    reasoning: bool = False,
    model: str = "anthropic/claude-sonnet-4.5",
    json_reply: bool = False,
    timeout: float = 60.0,
) -> str | AsyncGenerator[str, None] | None | dict:
    """
    OpenRouter API completion implementation.

    Args:
        instruction: System instruction
        content: User content
        stream: Whether to stream the response
        reasoning: Whether to enable reasoning mode
        model: Model name in format "vendor/model"
        json_reply: Whether to parse response as JSON
        timeout: Timeout in seconds

    Returns:
        String response, async generator for streaming, None on JSON parse error, or dict for json_reply
    """
    client = AsyncOpenAI(
        base_url="https://openrouter.ai/api/v1",
        api_key=default_service_config.openrouter_api_key,
    )
    extra_body = {"reasoning": {"effort": "high"}}
    messages: list[ChatCompletionSystemMessageParam | ChatCompletionUserMessageParam] = [
        ChatCompletionSystemMessageParam(role="system", content=instruction),
        ChatCompletionUserMessageParam(role="user", content=content),
    ]

    try:
        params = {
            "model": model,
            "messages": messages,
            "stream": stream,
        }
        if reasoning:
            # noinspection PyTypeChecker
            params["extra_body"] = extra_body

        if not stream:
            # Wrap with asyncio.wait_for for cancellation support
            response = await asyncio.wait_for(client.chat.completions.create(**params), timeout=timeout)
            content = response.choices[0].message.content or ""
            if json_reply:
                content = clean_fenced_completion(content)
                try:
                    json_response = json.loads(content)
                    return json_response
                except json.JSONDecodeError:
                    # noinspection PyTypeChecker
                    logging.error(f"Failed to decode JSON response: {content}")
                    return None
            return content if content else ""

        else:
            # Wrap streaming response with asyncio.wait_for for cancellation support
            response = await asyncio.wait_for(client.chat.completions.create(**params), timeout=timeout)
            first_token_received = False

            async def generator() -> AsyncGenerator[str, None]:
                nonlocal first_token_received
                try:
                    async for chunk in response:
                        # Check for cancellation between chunks
                        if asyncio.current_task() and asyncio.current_task().cancelled():
                            logging.info("LLM streaming cancelled")
                            return

                        chunk_content = getattr(chunk.choices[0].delta, "content", None)
                        if chunk_content and not first_token_received:
                            first_token_received = True
                        if chunk_content:
                            yield chunk_content
                except asyncio.CancelledError:
                    logging.info("LLM streaming cancelled via CancelledError")
                    raise

            return generator()

    except asyncio.TimeoutError:
        logging.warning(f"OpenRouter completion timed out after {timeout} seconds")
        if not stream:
            return ""

        async def timeout_gen() -> AsyncGenerator[str, None]:
            # noinspection PyUnreachableCode
            if False:
                yield ""

        return timeout_gen()

    except asyncio.CancelledError:
        logging.info("OpenRouter completion was cancelled")
        raise  # Re-raise cancellation to propagate properly

    except Exception as e:
        logging.error("Error in openrouter_completion: %s", e)
        if not stream:
            return ""

        async def empty_gen() -> AsyncGenerator[str, None]:
            # noinspection PyUnreachableCode
            if False:
                yield ""

        return empty_gen()
