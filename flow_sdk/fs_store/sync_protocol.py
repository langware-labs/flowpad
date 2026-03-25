"""Sync protocol types for resource notifications."""

from enum import StrEnum


class ResourceType(StrEnum):
    ENTITY = "entity"
    RELATIONSHIP = "relationship"


class SyncOperation(StrEnum):
    CREATE = "create"
    UPDATE = "update"
    DELETE = "delete"
    EVENT = "event"


class RefType(StrEnum):
    DATA = "data"
    PATH = "path"
