# Lexical document stub
from typing import Any, Dict, Optional
from pydantic import BaseModel


class LexicalRoot(BaseModel):
    """Lexical root document stub."""
    root: Dict[str, Any] = {}


def empty_lexical_root() -> LexicalRoot:
    """Return an empty lexical root."""
    return LexicalRoot()


def lexical_to_markdown(doc: LexicalRoot) -> str:
    """Convert lexical doc to markdown. Stub implementation."""
    return ""


__all__ = ["LexicalRoot", "empty_lexical_root", "lexical_to_markdown"]
