"""
Flow hook metadata model.
"""

from datetime import datetime
from typing import Optional
from pydantic import BaseModel, Field


class FlowHookMetadata(BaseModel):
    """
    Metadata stored in the "flow" section of hook entries.

    This identifies hooks as flow-managed and stores related metadata.
    """

    managed: bool = Field(default=True, description="Always True for flow-managed hooks")
    version: str = Field(default="1.0", description="Flow hook format version")
    name: Optional[str] = Field(default=None, description="Optional name for this hook")
    created_at: Optional[str] = Field(default=None, description="ISO timestamp when hook was created")

    @classmethod
    def create(cls, name: Optional[str] = None) -> "FlowHookMetadata":
        """Create a new FlowHookMetadata with current timestamp."""
        return cls(
            name=name,
            created_at=datetime.now().isoformat()
        )

    def to_dict(self) -> dict:
        """Convert to dict, excluding None values."""
        return {k: v for k, v in self.model_dump().items() if v is not None}
