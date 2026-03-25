import asyncio
from abc import ABC, abstractmethod
from typing import Annotated

import logfire
from openai import AsyncOpenAI

from flow_sdk.config import default_service_config
from flow_sdk import service_log
from flow_sdk.db.drivers.db_base_record import VectorSearch

Embedding = Annotated[list[float], VectorSearch]


class EmbeddingsDriver(ABC):
    @abstractmethod
    async def generate(
        self,
        texts: list[str],
        model: str | None = None,
    ) -> list[list[float]]:
        """Interface for the embeddings generation of text"""


class OpenAIEmbeddingsDriver(EmbeddingsDriver):
    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=default_service_config.openai_api_key, max_retries=default_service_config.embeddings_max_retries
        )

    async def generate(
        self,
        texts: list[str],
        model: str | None = None,
    ):
        if model is None:
            model = "text-embedding-3-small"

        try:
            openai_max_batch_size = 2048
            # Split the texts into batches and send them to OpenAI
            embeddings_results = await asyncio.gather(
                *(
                    self.client.embeddings.create(
                        model=model,
                        input=texts_batch,
                    )
                    for texts_batch in [
                        texts[i : i + openai_max_batch_size] for i in range(0, len(texts), openai_max_batch_size)
                    ]
                )
            )
            embeddings: list[list[float]] = []
            for result in embeddings_results:
                embeddings.extend([emb.embedding for emb in result.data])
            return embeddings
        except Exception as e:
            service_log.highlighted_error(f"Error in OpenAI embeddings: {e}")
            raise


_drivers: dict[str, EmbeddingsDriver] = {}
_initialized = False


def _initialize():
    if default_service_config.embeddings_driver == "openai":
        _drivers["openai"] = OpenAIEmbeddingsDriver()
    else:
        raise NotImplementedError(f"There is no embeddings driver for {default_service_config.embeddings_driver}")


def _get_driver(name: str | None = None) -> EmbeddingsDriver:
    global _initialized
    if not _initialized:
        _initialize()
    if name is None:
        name = default_service_config.embeddings_driver
    if name not in _drivers:
        raise ValueError(f"Unknown embeddings driver: {name}")
    return _drivers[name]


@logfire.instrument()
async def generate_embeddings(texts: list[str], model: str | None = None) -> list[list[float]]:
    return await _get_driver(model).generate(texts, model)
