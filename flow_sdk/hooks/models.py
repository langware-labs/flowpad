"""Data models for hook file management."""

from pathlib import Path
from typing import Optional
from uuid import uuid4

from pydantic import BaseModel, Field


class AgentHookMetadata(BaseModel):
    """Metadata for flow-managed hooks."""

    managed: bool = True
    version: str = "1.0"
    name: Optional[str] = None
    created_at: Optional[str] = None
    report_url: Optional[str] = None
    hook_entry_id: Optional[str] = None
    flowpad_hook_id: Optional[str] = None


class HookEntry(BaseModel):
    """A single hook entry with commands and optional matcher."""

    id: str = Field(default_factory=lambda: str(uuid4()))
    event: str
    matcher: Optional[str] = None
    commands: list[str] = Field(default_factory=list)
    flowpad_data: Optional[AgentHookMetadata] = None


class HookEntryResult(BaseModel):
    """Result of finding a hook entry."""

    model_config = {"arbitrary_types_allowed": True}

    entry: HookEntry
    file_path: Path
