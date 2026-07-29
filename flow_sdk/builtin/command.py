"""Slash command entity — per-type record knowledge.

A Command is a single ``.md`` file under ``<scope>/.claude/commands/`` that
defines a Claude Code slash command. The on-disk source is the markdown body;
the id is deterministic ``<scope>:<name>``.
"""
from __future__ import annotations

from typing import ClassVar

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity


class Command(Entity):
    """Claude Code slash-command entity. Source: ``<scope>/.claude/commands/<name>.md``."""

    type: str = APIField(default="command")
    name: str | None = APIField(default=None)
    command_name: str | None = APIField(default=None)
    content: str | None = APIField(default=None)
    asset_ref: str = APIField(default="", sharing=Sharing.PRIVATE)
