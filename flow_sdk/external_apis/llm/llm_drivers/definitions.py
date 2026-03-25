from enum import StrEnum
from typing import List, Literal

from pydantic import BaseModel


class LLMProvider(StrEnum):
    UNKNOWN = "Unknown"
    Anthropic = "Anthropic"
    Groq = "Groq"
    OpenAI = "OpenAI"
    VertexAI = "VertexAI"
    TestLLM = "TestLLM"
    Perplexity = "Perplexity"


class LLMModelInfo(BaseModel):
    provider: LLMProvider
    name: str
    max_input_tokens: int
    max_output_tokens: int


class LLMMessage(BaseModel):
    role: Literal["user", "assistant", "system"]
    content: str


class LLMResponse(BaseModel):
    messages: List[LLMMessage]
    completion: str
    citations: List[str] = []
    generation_time: float
    first_token_time: float
    completion_tokens: int
