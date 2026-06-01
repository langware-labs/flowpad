"""Base FS↔DB metadata schema.

``BaseMeta`` enumerates the metadata.json fields shared by every entity type.
Per-type metadata models subclass it to add type-specific persisted fields
(e.g. ``ShellMeta`` adds ``status``/``workdir``/``pty_pid``). A field declared
with ``persist=DEFAULT`` (the implicit default) is mirrored to disk iff its name
appears in the type's metadata model — falling back to ``BaseMeta`` when a type
registers none.

Lenient by construction: all fields optional, extras ignored. The model is used
for field-name membership, not strict validation.
"""
from __future__ import annotations

from typing import Any, Optional

from pydantic import BaseModel, ConfigDict


class BaseMeta(BaseModel):
    model_config = ConfigDict(extra="ignore")

    name: Optional[str] = None
    scope: Optional[str] = None
    project_id: Optional[str] = None
    created_date: Optional[Any] = None
    updated_date: Optional[Any] = None
