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
    # Canonical parent reference ("<type>-<id>") and the local "do I have a hub
    # twin" flag. Declared here so the declarative persist path (metadata_payload
    # ↔ from_record) mirrors them to/from metadata.json for every entity type.
    # ``remote`` stays in LOCAL_ONLY_FIELDS (a hub refresh must never overwrite
    # it) and is excluded from the hub push body by Entity.share(); BaseMeta
    # membership governs DISK persistence only, not the wire.
    parent_type_id: Optional[str] = None
    remote: Optional[bool] = None
    # Folder-like containment (docs/entities-groups.md): the Group this entity
    # lives in. Declared on BaseMeta so membership persists to metadata.json
    # for EVERY type — disk is the source of truth, grouping survives a full
    # index rebuild.
    group_id: Optional[str] = None
