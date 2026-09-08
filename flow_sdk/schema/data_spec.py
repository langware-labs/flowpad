"""Recursive, compact descriptions of data shapes authored at runtime."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, field_validator, model_serializer, model_validator

from flow_sdk.tags.grammar import normalize_tag


class DataSpec(BaseModel):
    """One schema node: a named shape, named children, or a repeated template."""

    kind: str | None = None
    fields: dict[str, "DataSpec"] | None = None
    each: "DataSpec | None" = None

    @model_validator(mode="before")
    @classmethod
    def _expand_kind_shorthand(cls, value: Any) -> Any:
        """Treat a bare kind string as its one-field object form."""
        return {"kind": value} if isinstance(value, str) else value

    @field_validator("kind")
    @classmethod
    def _normalize_kind(cls, value: str | None) -> str | None:
        return None if value is None else normalize_tag(value)

    @model_validator(mode="after")
    def _validate_shape(self) -> "DataSpec":
        if self.fields is not None and self.each is not None:
            raise ValueError("a DataSpec carries fields or each, not both")
        if self.kind is None and self.fields is None and self.each is None:
            raise ValueError("a DataSpec cannot be empty")
        return self

    def _compact(self) -> str | dict[str, Any]:
        if self.kind is not None and self.fields is None and self.each is None:
            return self.kind

        result: dict[str, Any] = {}
        if self.kind is not None:
            result["kind"] = self.kind
        if self.fields is not None:
            result["fields"] = {name: child._compact() for name, child in self.fields.items()}
        if self.each is not None:
            result["each"] = self.each._compact()
        return result

    def to_json(self) -> str | dict[str, Any]:
        """Return the recursively compact JSON-native representation."""
        return self._compact()

    @model_serializer(mode="plain")
    def _serialize_compact(self) -> str | dict[str, Any]:
        return self._compact()


DataSpec.model_rebuild()
