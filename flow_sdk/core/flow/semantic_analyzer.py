"""Semantic analysis types extracted from user prompts."""

from typing import List, Optional

from pydantic import BaseModel, Field

from flow_sdk.builtin.artifact import ArtifactType


class UserPromptAnalysis(BaseModel):
    """Semantic context extracted from user input."""

    user_prompt: Optional[str] = Field(None, description="Original user prompt")
    goal: str
    keywords: List[str] = Field(default_factory=list, description="Keywords extracted from the user prompt")
    labels: List[str] = Field(default_factory=list, description="Semantic labels matching ontology")
    expected_result_types: List[ArtifactType] = Field(
        default_factory=list, description="Expected artifact types from the prompt"
    )
    simple_answer: bool = Field(default=True, description="Whether the prompt requires a simple answer (True/False)")
