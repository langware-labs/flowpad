from enum import Enum
from typing import AsyncGenerator


class APIProvider(str, Enum):
    OPENROUTER = "openrouter"
    GROQ = "groq"


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
    # Import here to avoid circular imports
    from flow_sdk.external_apis.llm.simple_llm.groq_client import groq_completion
    from flow_sdk.external_apis.llm.simple_llm.openrouter_client import openrouter_completion

    # Set default timeout if not provided
    if timeout is None:
        timeout = 60.0  # Default 60 second timeout

    # Set default model if not provided
    if model is None:
        model = "anthropic/claude-sonnet-4.5"

    # Parse the model string to get provider and model name
    provider, model_name = parse_model_string(model)

    # Route to appropriate provider
    if provider == APIProvider.OPENROUTER:
        return await openrouter_completion(
            instruction=instruction,
            content=content,
            stream=stream,
            reasoning=reasoning,
            model=model_name,
            json_reply=json_reply,
            timeout=timeout,
        )
    elif provider == APIProvider.GROQ:
        return await groq_completion(
            instruction=instruction,
            content=content,
            stream=stream,
            reasoning=reasoning,
            model=model_name,
            json_reply=json_reply,
            timeout=timeout,
        )
    else:
        raise ValueError(f"Unsupported provider: {provider}")
