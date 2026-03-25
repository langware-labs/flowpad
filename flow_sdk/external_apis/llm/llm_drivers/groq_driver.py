import logging
import time
from typing import List, Optional, cast

from groq import AsyncGroq
from groq.types.chat import ChatCompletion, ChatCompletionMessageParam

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm.llm_drivers.definitions import LLMModelInfo, LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_base_driver import LLMDriver
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler
from flow_sdk.utils import count_tokens


class GroqDriver(LLMDriver):
    provider: LLMProvider = LLMProvider.Groq

    def __init__(self):
        self.client = AsyncGroq(
            api_key=default_service_config.groq_api_key,
            max_retries=0,
        )

    @classmethod
    def supported_models(cls) -> List[LLMModelInfo]:
        return [
            LLMModelInfo(
                name="llama-3.1-8b-instant", max_input_tokens=7000, max_output_tokens=2**13, provider=cls.provider
            ),
            LLMModelInfo(name="llama3-8b-8192", max_input_tokens=2**13, max_output_tokens=2**13, provider=cls.provider),
            LLMModelInfo(
                name="llama3-70b-8192", max_input_tokens=2**13, max_output_tokens=2**13, provider=cls.provider
            ),
        ]

    async def generate(
        self,
        messages,
        model: str,
        stop: List[str] | None = None,
        temperature: Optional[float] = 0,
        json_output: bool = False,
        callback_handler: Optional[CallbackHandler] = None,
        verbose: bool = False,
    ) -> LLMResponse:
        try:
            t0 = time.time()
            response_stream = await self.client.chat.completions.create(
                model=model,
                messages=cast(List[ChatCompletionMessageParam], messages),
                temperature=temperature,
                stop=stop,
                stream=(not json_output),
                response_format={"type": "json_object"} if json_output else {"type": "text"},
            )

            partial_message = ""
            first_token_time = 0.0
            if isinstance(response_stream, ChatCompletion):
                first_token_time = time.time() - t0
                if verbose:
                    logging.info(f"Time until first llm token: {first_token_time:.2f}s")
                if not isinstance(response_stream.choices[0].message.content, str):
                    raise ValueError(f"Invalid response from Groq API: {response_stream.choices[0].message.content}")
                partial_message = response_stream.choices[0].message.content
                if callback_handler:
                    await callback_handler.on_new_chunk(partial_message)
            else:
                last_chunk = None
                async for chunk in response_stream:
                    if last_chunk is None:
                        last_chunk = chunk
                        first_token_time = time.time() - t0
                        if verbose:
                            logging.info(f"Time until first llm token: {first_token_time:.2f}s")

                    if chunk.choices[0].delta.content is not None:
                        partial_message += chunk.choices[0].delta.content
                        if callback_handler:
                            await callback_handler.on_new_chunk(chunk.choices[0].delta.content)

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
                generation_time=t1 - t0,
                first_token_time=first_token_time,
                completion_tokens=completion_tokens,
            )
        except Exception as e:
            if callback_handler is not None:
                await callback_handler.on_error(e)

            logging.error(f"Error in Groq completion: {e}")
            raise
