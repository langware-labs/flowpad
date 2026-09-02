from enum import Enum
from functools import lru_cache
from typing import TYPE_CHECKING, AsyncGenerator

if TYPE_CHECKING:
    from flow_sdk.external_apis.llm.dialects import ProviderDialect


class APIProvider(str, Enum):
    OPENROUTER = "openrouter"
    GROQ = "groq"


#: Groq is deliberately NOT in ``LMApiProvider``: it is not a funding source a worker or an
#: endpoint can be pointed at, only a base URL this one function knows. It speaks the OpenAI
#: wire protocol, so one client covers it and OpenRouter both — the vendor SDKs added nothing
#: but a second copy of the same request/stream/timeout dance.


@lru_cache(maxsize=1)
def _generic_openai_dialect() -> "ProviderDialect":
    """A dialect for an endpoint we know nothing about beyond "it speaks OpenAI".

    Callers of :func:`openai_compatible_completion` have already resolved the base URL, the
    key and the model, so nothing the registry would supply is consulted — only the wire.
    Cached because it is a constant; built lazily to keep this module import-light.
    """
    from flow_sdk.external_apis.llm.dialects import (  # noqa: PLC0415
        WIRE_OPENAI,
        ProviderDialect,
        _bearer,
    )
    from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider  # noqa: PLC0415

    return ProviderDialect(
        provider=LMApiProvider.OPENROUTER,
        default_base_url="",
        _auth=_bearer,
        wire=WIRE_OPENAI,
    )


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

    ``timeout`` is a ceiling on the call, not a retry budget.

    **This raises** :class:`~flow_sdk.external_apis.llm.errors.LLMError` on failure. It used
    to answer ``""`` for a timeout, a 401, a missing model and a model that genuinely said
    nothing alike, which made it impossible for any caller to explain a failure. The callers
    that want best-effort prose keep that behaviour by catching ``LLMError`` themselves — see
    :func:`llm_completion`.
    """
    from flow_sdk.external_apis.llm.client import LLMClient  # noqa: PLC0415

    client = LLMClient(
        dialect=_generic_openai_dialect(),
        base_url=base_url,
        api_key=api_key,
        label=provider_label,
    )
    return await client.create_completion(
        system,
        user,
        model=model,
        stream=stream,
        json_reply=json_reply,
        reasoning=reasoning,
        timeout=timeout,
    )


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

    Best-effort by contract: every failure becomes an empty answer (``""``, or an empty
    stream), and a reply that was asked to be JSON but was not becomes ``None``. Both of
    this function's callers are search helpers that degrade rather than fail, so the
    swallowing lives here — one level above the primitive, which raises.

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
    import logging  # noqa: PLC0415

    from flow_sdk.config import default_service_config  # noqa: PLC0415
    from flow_sdk.external_apis.llm.errors import LLMError, LLMInvalidJSON  # noqa: PLC0415

    async def _empty_gen() -> "AsyncGenerator[str, None]":
        # noinspection PyUnreachableCode
        if False:
            yield ""

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

    try:
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
    except LLMInvalidJSON as exc:
        logging.error("Failed to decode JSON response: %s", exc.body)
        return None
    except LLMError as exc:
        logging.error("Error in %s completion: %s", provider.value, exc)
        return _empty_gen() if stream else ""
