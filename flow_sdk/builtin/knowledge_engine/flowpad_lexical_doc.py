# Flowpad lexical doc stub
from typing import Any, Dict, Optional
from pydantic import BaseModel


class FlowpadLexicalDoc(BaseModel):
    """Flowpad lexical document stub."""
    content: Dict[str, Any] = {}
    title: Optional[str] = None


__all__ = ["FlowpadLexicalDoc"]
