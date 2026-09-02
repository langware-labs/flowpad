"""Process-wide embedding generation.

A thin façade over :class:`~flow_sdk.external_apis.llm.client.LLMClient`, kept because
``generate_embeddings`` is an established import. Anything that needs to choose *which*
credential pays should go through an ``LLMEndpoint`` and call its client directly; this
module is the legacy path, funded by the process-wide OpenAI key.
"""

from typing import Annotated

import logfire

from flow_sdk import service_log
from flow_sdk.config import default_service_config
from flow_sdk.db.drivers.db_base_record import VectorSearch
from flow_sdk.external_apis.llm.client import LLMClient
from flow_sdk.external_apis.llm.errors import LLMError
from flow_sdk.flowpad_types.enums.lm_provider_enums import LMApiProvider

Embedding = Annotated[list[float], VectorSearch]


@logfire.instrument()
async def generate_embeddings(texts: list[str], model: str | None = None) -> list[list[float]]:
    """Embed ``texts`` with the configured driver, preserving order.

    ``model`` selects a *model*, not a driver. It used to be handed to a driver registry as a
    driver NAME, so any caller that named a model got ``ValueError: Unknown embeddings
    driver`` — never noticed, because the only caller passes none. That registry wrapped a
    single implementation and is gone; batching, retries and the provider dialect all live in
    :class:`LLMClient` now.
    """
    driver = default_service_config.embeddings_driver
    if driver != LMApiProvider.OPENAI.value:
        raise NotImplementedError(f"There is no embeddings driver for {driver}")

    client = LLMClient.for_dialect(
        LMApiProvider.OPENAI,
        api_key=default_service_config.openai_api_key,
        label="openai embeddings",
    )
    try:
        return await client.create_embeddings(texts, model=model)
    except LLMError as e:
        service_log.highlighted_error(f"Error in OpenAI embeddings: {e}")
        raise
