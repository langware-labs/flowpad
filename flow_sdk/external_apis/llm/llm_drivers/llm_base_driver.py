from abc import ABC, abstractmethod
from typing import List, Optional

from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMMessage, LLMModelInfo, LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler


class LLMDriver(ABC):
    provider: LLMProvider = LLMProvider.UNKNOWN

    @abstractmethod
    async def generate(
        self,
        messages: List[LLMMessage],
        model: str,
        stop: List[str] | None = None,
        temperature: Optional[float] = None,
        json_output: bool = False,
        callback_handler: Optional[CallbackHandler] = None,
        verbose: bool = False,
    ) -> LLMResponse:
        """Interface for the llm generation of text"""

    @classmethod
    @abstractmethod
    def supported_models(cls) -> List[LLMModelInfo]:
        """List of supported models"""
