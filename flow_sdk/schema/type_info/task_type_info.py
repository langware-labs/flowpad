"""Type metadata for TASK.

Task is a FOLDER-backed markdown asset, modelled on ``skill``: its ``asset_ref``
is the ``tasks/<name>/`` folder, ``task.md`` is the main doc, and an inner
``spec.md`` (the plan/issue content) rides along as a plain file. ``owns_main_ref``
is True (like ``spec``): the entity is the source of truth for its fields, so
every save re-renders ``task.md`` through the serializer (``TaskSpec``) and the
generic reindex reads it back — no bespoke JSON manifest, no bespoke share packer.
"""
from __future__ import annotations

from flow_sdk.builtin.task import TaskSpec
from flow_sdk.fs_store.indexer.functions._asset_identity import (
    IDENTITY_CAPSULE,
    folder_capsule_id,
    folder_capsule_json_id,
    frontmatter_identity,
    in_folder,
)
from flow_sdk.fs_store.indexer.functions.task import (
    derive_task,
    task_asset_hash,
    task_id_from_folder,
)
from flow_sdk.fs_store.schema_registry import TypeInfo
from flow_sdk.schema.layout import Folder
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

TASK = TypeInfo(
    type_name=EntityType.TASK,
    icon="CheckSquare",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "objective"],
    asset_class="repo",
    family="task",
    shape=Folder(main="task.md"),
    editor="task",
    fts_content=("title", "description"),
    capsules=(IDENTITY_CAPSULE,),
    identity_carrier=frontmatter_identity(folder_capsule_json_id, in_folder(folder_capsule_id), in_folder(task_id_from_folder)),
    asset_hash_fn=task_asset_hash,
    # ``TaskSpec`` IS the share whitelist — see its docstring.
    asset_spec=TaskSpec,
    derive_fields_fn=derive_task,
    owns_main_ref=True,
    # An assignee moves the work along; they don't get to rewrite the ask. These
    # are the only fields their hub-reflected update carries, which is what makes
    # ONE shared task row safe to hand to someone (see ``assignee_owned_fields``).
    assignee_owned_fields=("status", "completed_at"),
    # The plan stays home. ``spec.md`` is authored beside ``task.md`` in the same
    # folder, and the bundle packer copies folders verbatim — so sharing or
    # assigning a task used to ship the owner's plan with it, contradicting the
    # decoupling this type documents.
    pack_exclude=("spec.md",),
)
