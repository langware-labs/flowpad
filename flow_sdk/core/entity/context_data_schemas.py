"""Typed schemas for per-type ``context_entity_data`` sidecar payloads.

Context-entry sidecars live on every Entity as
``shared_context_entity_data`` / ``private_context_entity_data`` —
dicts keyed by ``str(typeid)`` whose values are per-type metadata
harvested at detection time. This module declares the value shapes
per entity type so the contract is visible at the class definition
of the targeted entity (not buried in the cross-link site).

Validation is best-effort: ``Entity._add_to_bucket`` calls
``schema.model_validate(data)`` and logs a warning on mismatch, but
still stores the data. The sidecar is a *hint* for the dock loader's
404 self-heal; a malformed hint just degrades to the pre-fix 404
behavior, never crashes.

To add a new schema:
    1. Subclass an existing shape (``PathContextData`` for file-backed
       entities) or define a new ``BaseModel`` here.
    2. Assign it to ``context_data_schema`` on the target Entity class.
"""

from __future__ import annotations

from pydantic import BaseModel


class PathContextData(BaseModel):
    """Sidecar shape for file-backed context entries.

    Carries the absolute filesystem path of the entity's backing asset
    so the dock loader can single-file-rehydrate the entity row when
    a chip click 404s (entity referenced before the indexer walked).

    Used by: ClaudePlan, Markdown (and its subclasses Docs / ClaudeMemory
    / ClaudeRules), ClaudeMd, Skill, ClaudeCommand.
    """

    path: str


class PlanContextData(PathContextData):
    """Per-entry data for ``plan-<id>`` context references."""


class MarkdownContextData(PathContextData):
    """Per-entry data for ``markdown-<id>`` / ``docs-<id>`` / ``claude_memory-<id>``
    / ``claude_rules-<id>`` context references. Subclasses can add
    ``vault_root`` or similar fields later without touching call sites."""


class SkillContextData(PathContextData):
    """Per-entry data for ``skill-<id>`` context references."""


class ClaudeMdContextData(PathContextData):
    """Per-entry data for ``claude_md-<id>`` context references."""


class ClaudeCommandContextData(PathContextData):
    """Per-entry data for ``command-<id>`` context references."""
