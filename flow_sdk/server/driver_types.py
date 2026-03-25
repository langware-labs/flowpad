"""Driver type identifiers for FlowServer configuration."""

from enum import Enum


class FlowDrivers(str, Enum):
    DB = "db"
    SOD = "sod"
    STORAGE = "storage"
