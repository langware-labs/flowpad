import logging
import time
from typing import List, Optional, cast

from openai import AsyncOpenAI
from openai.types.chat.chat_completion_message_param import ChatCompletionMessageParam

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm import LLMMessage, LLMModelInfo, LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_base_driver import LLMDriver
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler
from flow_sdk.utils import count_tokens


class PerplexityDriver(LLMDriver):
    provider: LLMProvider = LLMProvider.Perplexity

    def __init__(self):
        self.client = AsyncOpenAI(
            api_key=default_service_config.perplexity_api_key,
            max_retries=0,
            base_url="https://api.perplexity.ai",
        )

    @classmethod
    def supported_models(cls) -> List[LLMModelInfo]:
        return [LLMModelInfo(name="sonar-pro", max_input_tokens=200000, max_output_tokens=2**13, provider=cls.provider)]

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
            partial_message = ""
            response_stream = await self.client.chat.completions.create(
                model=model,
                messages=cast(List[ChatCompletionMessageParam], messages),
                temperature=temperature,
                stop=stop,
                stream=True,
                # response_format={"type": "json_schema", "json_schema": {"schema": AnswerFormat.model_json_schema()}}
                # if json_output else {"type": "text"},
                # response_format={"type": "json_schema"} if json_output else {"type": "text"},
            )

            last_chunk = None
            first_token_time = 0.0
            citations = set()
            async for chunk in response_stream:
                if last_chunk is None:
                    first_token_time = time.time() - t0
                    if verbose:
                        logging.info(f"Time until first llm token: {first_token_time:.2f}s")
                last_chunk = chunk

                if chunk.choices[0].delta.content is not None:
                    partial_message += chunk.choices[0].delta.content
                    if callback_handler:
                        await callback_handler.on_new_chunk(chunk.choices[0].delta.content)
                if chunk.citations:
                    citations.update(chunk.citations)
            full_message = partial_message
            completion_tokens = await count_tokens(full_message)
            t1 = time.time()
            if verbose:
                logging.info(f"Time until last llm response: {t1 - t0:.2f}s")
                logging.info(f"Completion tokens: {completion_tokens}")

            if callback_handler:
                await callback_handler.on_llm_end()

            return LLMResponse(
                messages=messages,
                completion=full_message,
                citations=list(citations),
                generation_time=t1 - t0,
                first_token_time=first_token_time,
                completion_tokens=completion_tokens,
            )
        except Exception as e:
            if callback_handler is not None:
                await callback_handler.on_error(e)

            logging.error(f"Error in GPT completion: {e}")
            raise
