"""Presence sentinel shared by typed call inputs and answer constructors."""

from enum import Enum


class _Missing(Enum):
    VALUE = "missing"


MISSING = _Missing.VALUE
