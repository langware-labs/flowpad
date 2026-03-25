"""Ontology model for knowledge base."""

from typing import Any, Dict, List, Optional

from pydantic import BaseModel, Field


class LabelInfo(BaseModel):
    """Label information for ontology entries."""

    label: str
    description: Optional[str] = None
    examples: List[str] = Field(default_factory=list)


class Ontology(BaseModel):
    """Ontology model for organizing knowledge entries."""

    name: Optional[str] = None
    description: Optional[str] = None
    categories: List[str] = Field(default_factory=list)
    relationships: Dict[str, Any] = Field(default_factory=dict)
    metadata: Dict[str, Any] = Field(default_factory=dict)
    labels: List[LabelInfo] = Field(default_factory=list)
