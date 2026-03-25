"""Scope definitions for filesystem and cloud resources."""

from enum import Enum


class Scope(str, Enum):
    """Scope/location of a resource."""

    MANAGED = "managed"
    USER = "user"
    GLOBAL = "global"
    PROJECT = "project"
    LOCAL = "local"
    LEGACY = "legacy"
