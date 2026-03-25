from enum import Enum
from typing import Any, Generic, TypeVar

from pydantic import BaseModel, ConfigDict, Field, field_serializer

T = TypeVar("T")


class Resolvable(BaseModel, Generic[T]):
    """
    A resolvable value that can be set by user or auto-resolved by model.

    The value property holds the user's selection (can be "auto").
    The model_choice property holds the model's auto-selection (None if never resolved).
    The resolved property returns the effective value (model_choice if present, else value).
    """

    model_config = ConfigDict(arbitrary_types_allowed=True, protected_namespaces=())

    value: T | str = Field(description="User-selected value or 'auto'")
    model_choice: T | None = Field(default=None, description="Model's auto-selection")

    @field_serializer("value", "model_choice")
    def serialize_enum_values(self, value: Any) -> Any:
        """Serialize enum values to their string representation."""
        if isinstance(value, Enum):
            return value.value
        return value

    @property
    def resolved(self) -> T:
        """
        Get the resolved value: model_choice if set, otherwise value.
        For lists: merges model_choice and value (model_choice first, then unique values from value).
        """
        if self.model_choice is not None:
            # Special handling for lists: merge instead of replace
            if isinstance(self.model_choice, list) and isinstance(self.value, list):
                # model_choice items first, then unique items from value
                merged = list(self.model_choice)
                for item in self.value:
                    if item not in merged:
                        merged.append(item)
                return merged  # type: ignore
            return self.model_choice
        # If value is "auto" but model_choice is None, return value as-is
        # The caller should handle the "auto" case
        return self.value  # type: ignore

    def set_model_choice(self, choice: T) -> None:
        """Set the model's choice for this resolvable."""
        self.model_choice = choice

    def reset_model_choice(self) -> None:
        """Clear the model's choice."""
        self.model_choice = None
