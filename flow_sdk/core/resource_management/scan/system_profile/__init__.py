"""System profile scanner package (bundled)."""

from .scanner import (
    get_resource_summary,
    list_projects_fast,
    scan_full,
    scan_item,
    scan_project,
    scan_resources,
)

__all__ = [
    "scan_full",
    "scan_item",
    "scan_resources",
    "scan_project",
    "list_projects_fast",
    "get_resource_summary",
]
