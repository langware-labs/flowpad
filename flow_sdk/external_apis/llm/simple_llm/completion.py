from enum import Enum
from typing import AsyncGenerator


class APIProvider(str, Enum):
    OPENROUTER = "openrouter"
    GROQ = "groq"


#: Where each provider's OpenAI-compatible endpoint lives, and which config
#: field holds its key. Groq speaks the OpenAI wire protocol on this path, so
#: one client covers both — the vendor SDKs added nothing but a second copy of
#: the same 120-line request/stream/timeout dance.
async def openai_compatible_completion(
    *,
    base_url: str,
    api_key: str | None,
    model: str,
    system: str,
    user: str,
    stream: bool = False,
    reasoning: bool = False,
    json_reply: bool = False,
    timeout: float = 60.0,
    provider_label: str = "llm",
) -> "str | AsyncGenerator[str, None] | None | dict":
    """One chat completion against any OpenAI-compatible endpoint.

    ``timeout`` is a ceiling on the call, not a retry budget: on expiry the
    caller gets an empty answer (or an empty stream) rather than a raised
    exception, which is what every caller here already expected.
    """
    import asyncio  # noqa: PLC0415
    import json  # noqa: PLC0415
    import logging  # noqa: PLC0415

    from openai import AsyncOpenAI  # noqa: PLC0415
    from openai.types.chat import (  # noqa: PLC0415
        ChatCompletionSystemMessageParam,
        ChatCompletionUserMessageParam,
    )

    from flow_sdk.external_apis.llm.utils.utils import clean_fenced_completion  # noqa: PLC0415

    async def _empty_gen() -> "AsyncGenerator[str, None]":
        # noinspection PyUnreachableCode
        if False:
            yield ""

    client = AsyncOpenAI(base_url=base_url, api_key=api_key)
    params: dict = {
        "model": model,
        "messages": [
            ChatCompletionSystemMessageParam(role="system", content=system),
            ChatCompletionUserMessageParam(role="user", content=user),
        ],
        "stream": stream,
    }
    if reasoning:
        params["extra_body"] = {"reasoning": {"effort": "high"}}

    try:
        response = await asyncio.wait_for(client.chat.completions.create(**params), timeout=timeout)

        if not stream:
            text = response.choices[0].message.content or ""
            if not json_reply:
                return text
            text = clean_fenced_completion(text)
            try:
                return json.loads(text)
            except json.JSONDecodeError:
                logging.error("Failed to decode JSON response: %s", text)
                return None

        async def generator() -> "AsyncGenerator[str, None]":
            try:
                async for chunk in response:
                    task = asyncio.current_task()
                    if task is not None and task.cancelled():
                        logging.info("LLM streaming cancelled")
                        return
                    chunk_content = getattr(chunk.choices[0].delta, "content", None)
                    if chunk_content:
                        yield chunk_content
            except asyncio.CancelledError:
                logging.info("LLM streaming cancelled via CancelledError")
                raise

        return generator()

    except asyncio.TimeoutError:
        logging.warning("%s completion timed out after %s seconds", provider_label, timeout)
        return _empty_gen() if stream else ""
    except asyncio.CancelledError:
        logging.info("%s completion was cancelled", provider_label)
        raise  # propagate cancellation
    except Exception as exc:  # noqa: BLE001
        logging.error("Error in %s completion: %s", provider_label, exc)
        return _empty_gen() if stream else ""


def parse_model_string(model: str) -> tuple[APIProvider, str]:
    """
    Parse model string to extract API provider and model name.

    Args:
        model: Model string in format "provider/vendor/model..." or "vendor/model..."

    Returns:
        Tuple of (APIProvider, model_name)

    Raises:
        ValueError: If provider is unknown

    Examples:
        "anthropic/claude-sonnet-4.5" -> (APIProvider.OPENROUTER, "anthropic/claude-sonnet-4.5")
        "openrouter/anthropic/claude-sonnet-4.5" -> (APIProvider.OPENROUTER, "anthropic/claude-sonnet-4.5")
        "groq/meta-llama/llama-3.1-8b-instant" -> (APIProvider.GROQ, "meta-llama/llama-3.1-8b-instant")
    """
    parts = model.split("/")

    if len(parts) < 2:
        raise ValueError(f"Invalid model string format: {model}. Expected at least 'vendor/model'")

    # Check if the first part is a known provider
    first_part = parts[0].lower()
    try:
        provider = APIProvider(first_part)
        # First part is the provider, rejoin the rest as model name
        model_name = "/".join(parts[1:])
        return provider, model_name
    except ValueError:
        # First part is not a provider, assume default provider (openrouter)
        return APIProvider.OPENROUTER, model


async def llm_completion(
    instruction: str,
    content: str,
    stream: bool = False,
    reasoning: bool = False,
    model: str | None = None,
    json_reply: bool = False,
    timeout: float | None = None,
) -> str | AsyncGenerator[str, None] | None | dict:
    """
    Main LLM completion function that routes to appropriate provider.

    Args:
        instruction: System instruction
        content: User content
        stream: Whether to stream the response
        reasoning: Whether to enable reasoning mode
        model: Model string in format "vendor/model" or "provider/vendor/model"
               Defaults to "anthropic/claude-sonnet-4.5" (openrouter)
        json_reply: Whether to parse response as JSON
        timeout: Timeout in seconds (default 60.0)

    Returns:
        String response, async generator for streaming, None on JSON parse error, or dict for json_reply

    Examples:
        model="anthropic/claude-sonnet-4.5" -> Uses OpenRouter (default provider)
        model="openrouter/anthropic/claude-sonnet-4.5" -> Explicitly uses OpenRouter
        model="groq/meta/llama-3" -> Uses Groq
    """
    from flow_sdk.config import default_service_config  # noqa: PLC0415

    if timeout is None:
        timeout = 60.0
    if model is None:
        model = "anthropic/claude-sonnet-4.5"

    provider, model_name = parse_model_string(model)
    if provider is APIProvider.OPENROUTER:
        base_url, api_key = "https://openrouter.ai/api/v1", default_service_config.openrouter_api_key
    elif provider is APIProvider.GROQ:
        base_url, api_key = "https://api.groq.com/openai/v1", default_service_config.groq_api_key
    else:
        raise ValueError(f"Unsupported provider: {provider}")

    return await openai_compatible_completion(
        base_url=base_url,
        api_key=api_key,
        model=model_name,
        system=instruction,
        user=content,
        stream=stream,
        reasoning=reasoning,
        json_reply=json_reply,
        timeout=timeout,
        provider_label=provider.value,
    )
