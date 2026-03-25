"""Stub FlowData module."""

from enum import StrEnum
from pydantic import BaseModel


class FlowDataType(StrEnum):
    """Stub FlowDataType enum."""
    STRING = "string"
    NUMBER = "number"
    OBJECT = "object"


class FlowElementType(StrEnum):
    """Stub FlowElementType enum."""
    INPUT = "input"
    OUTPUT = "output"


class ViewType(StrEnum):
    """Stub ViewType enum."""
    MAIN = "main"
    DETAIL = "detail"


class FlowData(BaseModel):
    """Stub FlowData class."""
    pass
