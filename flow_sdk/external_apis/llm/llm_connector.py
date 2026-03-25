import asyncio
import json
import logging
from typing import Dict, List, Optional, Tuple, Type

from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMMessage, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_base_driver import LLMDriver
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler
from flow_sdk.external_apis.llm.utils.cache_manager import get_cached_response, save_response_to_cache
from flow_sdk.utils import count_tokens

from flow_sdk import service_log
from flow_sdk.request_context.methods import get_current_service_config
from . import LLMModelInfo

_drivers: Dict[str, Tuple[LLMDriver, LLMModelInfo]] = {}
_initialized = False


def _initialize():
    """Initialize the module, registering all drivers."""
    global _initialized
    if _initialized:
        return

    from flow_sdk.external_apis.llm.llm_drivers.test_driver import TestLLMDriver

    _add_driver(TestLLMDriver)

    from flow_sdk.external_apis.llm.llm_drivers.vertexai_driver import VertexAIDriver

    _add_driver(VertexAIDriver)

    from flow_sdk.external_apis.llm.llm_drivers.openai_driver import OpenAIDriver

    _add_driver(OpenAIDriver)

    from flow_sdk.external_apis.llm.llm_drivers.groq_driver import GroqDriver

    _add_driver(GroqDriver)

    from flow_sdk.external_apis.llm.llm_drivers.anthropic_driver import AnthropicDriver

    _add_driver(AnthropicDriver)

    from flow_sdk.external_apis.llm.llm_drivers.perplexity_driver import PerplexityDriver

    _add_driver(PerplexityDriver)

    _initialized = True


def _add_driver(driver_class: Type[LLMDriver]):
    """Register a driver by its name and supported models."""
    provider_name = driver_class.provider.lower()
    driver = driver_class()

    # Register the driver by its class name or model
    driver_models = driver_class.supported_models()
    _drivers[provider_name] = (driver, driver_models[0])
    for model in driver_models:
        _drivers[model.name.lower()] = (driver, model)


def _get_driver(input_tokens: int, name: str | None = None) -> tuple[LLMDriver, LLMModelInfo]:
    """Retrieve the driver by name or the default from the service config."""
    _initialize()
    service_config = get_current_service_config()
    if name is None:
        name = service_config.llm_driver
    name = name.lower()
    if name not in _drivers:
        raise ValueError(f"Unknown LLM driver: {name}")
    model_info = _drivers[name][1]
    if input_tokens > model_info.max_input_tokens:
        raise ValueError(f"Input tokens {input_tokens} exceed the limit of {model_info.max_input_tokens}. Skipping.")
    return _drivers[name]


async def send_request_to_llm(
    messages: List[LLMMessage],
    provider_or_model: Optional[str | List[str]] = None,
    verbose: bool = False,
    no_cache: bool = False,
    callback_handler: Optional[CallbackHandler] = None,
    timeout: Optional[float] = None,
    **llm_args,
) -> LLMResponse:
    """Send a request to the LLM using the specified or default driver."""
    service_config = get_current_service_config()
    messages_dict = [m.model_dump() for m in messages]
    prompt_string = json.dumps(messages_dict, indent=service_config.python_indent_level)
    input_tokens = await count_tokens([message.content for message in messages])
    cached_response = get_cached_response(prompt_string)
    if cached_response and not no_cache:
        service_log.info("Returning cached response")
        if verbose:
            logging.info("Returning cached response")
        if callback_handler:
            await callback_handler.on_cached_message(cached_response)
            await callback_handler.on_llm_end()
        return cached_response

    if service_config.llm_driver == "testllm":
        # Force the test driver without fallbacks
        provider_or_model = ["testllm"]
    elif provider_or_model is None:
        provider_or_model = service_config.llm_driver
    if isinstance(provider_or_model, str):
        provider_or_model = [provider_or_model] + [
            driver for driver in service_config.llm_fallback_drivers if driver != provider_or_model
        ]

    # Try each model in order
    while provider_or_model:
        provider_or_model_name = provider_or_model.pop(0)
        try:
            if verbose:
                for message_i, message in enumerate(messages):
                    role = message.role
                    content = message.content
                    logging.info(f"################## S{provider_or_model_name}_{message_i}_{role} ##################")
                    logging.info(content)
                    logging.info(f"################## E{provider_or_model_name}_{message_i}_{role} ##################")

            driver, model_info = _get_driver(input_tokens, name=provider_or_model_name)

            # Generate response with timeout
            response = await asyncio.wait_for(
                driver.generate(
                    messages=messages,
                    model=model_info.name,
                    callback_handler=callback_handler,
                    verbose=verbose,
                    **llm_args,
                ),
                timeout=timeout or service_config.llm_generation_timeout,
            )

            if verbose:
                logging.info(f"################## {provider_or_model_name}_S_COMPLETION ##################")
                logging.info(response.completion)
                logging.info(f"################## {provider_or_model_name}_E_COMPLETION ##################")
            save_response_to_cache(prompt_string, response.completion)
            return response
        except Exception as e:
            logging.error(f"Error with model {provider_or_model_name}: {e}")
            # logging.error(f"\n{''.join(traceback.format_stack())}")
    raise Exception("No LLM driver could generate a response")
