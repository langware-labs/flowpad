# LLM API stub
from typing import Any, Dict, List, Optional
from pydantic import BaseModel


class LLMMessage(BaseModel):
    """LLM message stub."""
    role: str = "user"
    content: str = ""


__all__ = ["LLMMessage"]
