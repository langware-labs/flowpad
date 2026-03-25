import json
import logging
import time
import traceback
from typing import Dict, List, Optional

import vertexai
from vertexai.generative_models import GenerativeModel
from vertexai.preview.generative_models import HarmBlockThreshold, HarmCategory

from flow_sdk.config import default_service_config
from flow_sdk.external_apis.llm import LLMMessage, LLMModelInfo, LLMProvider, LLMResponse
from flow_sdk.external_apis.llm.llm_drivers.llm_base_driver import LLMDriver
from flow_sdk.external_apis.llm.llm_drivers.llm_callbacks import CallbackHandler

UNDERSTOOD_SYSTEM_PROMPT = """
```json
{
  "content": "Understood.\\n\\nI will return a COMPLETE json response."
}
```
"""


def transform_to_gemini(messages: List[LLMMessage], json_output: bool):
    messages_gemini: List[Dict[str, str | List[Dict[str, str]]]] = []
    empty_message_text = "<empty>"

    def add_empty_message(role: str, index=None):
        # Gemini can't handle empty messages, so we add a placeholder
        if index is not None:
            messages_gemini.insert(index, {"role": role, "parts": [{"text": empty_message_text}]})
            return
        messages_gemini.append({"role": role, "parts": [{"text": empty_message_text}]})

    for message in messages:
        if message.role == "system":
            if not message.content:
                continue
            # Add system messages first
            messages_gemini.insert(0, {"role": "user", "parts": [{"text": message.content}]})
            messages_gemini.insert(
                1,
                {
                    "role": "model",
                    "parts": [{"text": UNDERSTOOD_SYSTEM_PROMPT if json_output else "Understood."}],
                },
            )
            if len(messages_gemini) > 2 and messages_gemini[2]["role"] == "model":
                add_empty_message("user", 0)
        elif message.role == "assistant":
            if messages_gemini and messages_gemini[-1]["role"] == "model":
                add_empty_message("user")
            messages_gemini.append({"role": "model", "parts": [{"text": message.content or empty_message_text}]})
        else:
            if messages_gemini and messages_gemini[-1]["role"] == "user":
                add_empty_message("model")
            messages_gemini.append({"role": "user", "parts": [{"text": message.content or empty_message_text}]})

    return messages_gemini


class VertexAIDriver(LLMDriver):
    provider: LLMProvider = LLMProvider.VertexAI

    def __init__(self):
        vertexai.init(
            project=default_service_config.google_cloud_project_id,
            location=default_service_config.google_cloud_project_location,
        )

    @classmethod
    def supported_models(cls) -> List[LLMModelInfo]:
        return [
            LLMModelInfo(
                name="gemini-2.0-flash", max_input_tokens=2**20, max_output_tokens=2**13, provider=cls.provider
            ),
            LLMModelInfo(
                name="gemini-2.0-flash-lite-preview-02-05",
                max_input_tokens=2**20,
                max_output_tokens=2**13,
                provider=cls.provider,
            ),
            LLMModelInfo(
                name="gemini-1.5-flash-preview-0514",
                max_input_tokens=2**20,
                max_output_tokens=2**13,
                provider=cls.provider,
            ),
            LLMModelInfo(
                name="gemini-1.5-flash", max_input_tokens=2**20, max_output_tokens=2**13, provider=cls.provider
            ),
        ]

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
        safety_settings = {
            HarmCategory.HARM_CATEGORY_HATE_SPEECH: HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_DANGEROUS_CONTENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_SEXUALLY_EXPLICIT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
            HarmCategory.HARM_CATEGORY_HARASSMENT: HarmBlockThreshold.BLOCK_ONLY_HIGH,
        }

        gen_model = GenerativeModel(model)
        generation_config = {
            "max_output_tokens": 8192,
            "temperature": temperature,
            "stop_sequences": stop,
            # TODO use when they make it better
            # "response_mime_type": "application/json",
        }

        try:
            t0 = time.time()
            partial_message = ""
            gemini_messages = transform_to_gemini(messages, json_output=json_output)

            responses = await gen_model.generate_content_async(
                gemini_messages,
                generation_config=generation_config,
                safety_settings=safety_settings,
                stream=True,
            )

            last_response = None
            first_token_time = 0.0
            async for response in responses:
                if last_response is None:
                    first_token_time = time.time() - t0
                    if verbose:
                        logging.info(f"Time until first llm token: {first_token_time:.2f}s")

                last_response = response
                try:
                    if response.candidates is None or len(response.candidates) == 0:
                        raise Exception(f"No candidates in llm response: {response}")
                    candidate = response.candidates[0]
                    if any([safety.blocked for safety in candidate.safety_ratings]):
                        raise Exception(f"Gemini blocked the completion due to safety concerns: {response}")
                    partial_message += candidate.text
                except Exception:
                    logging.error(
                        "\n".join(
                            [
                                "Error getting candidate.text:",
                                "Response:",
                                str(last_response),
                                "Gemini messages:",
                                json.dumps(gemini_messages, indent=default_service_config.json_indent_level),
                            ]
                        )
                    )
                    raise

                if callback_handler is not None:
                    await callback_handler.on_new_chunk(candidate.text)

            if last_response is None:
                raise Exception("No output from Gemini")
            if last_response.candidates[0].finish_reason != 1:
                raise Exception(
                    "Gemini did not finish successfully "
                    f"({last_response.candidates[0].finish_reason}): "
                    f"{last_response.candidates[0].finish_message}"
                )

            full_message = partial_message
            t1 = time.time()
            completion_tokens = last_response.usage_metadata.candidates_token_count

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
            if callback_handler:
                await callback_handler.on_error(e)

            logging.error(
                f"Error in Gemini completion: {traceback.format_exc()}\nwith stack:\n\n{''.join(traceback.format_stack())}"
            )
            raise
