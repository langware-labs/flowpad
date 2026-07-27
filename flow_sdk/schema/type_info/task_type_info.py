"""Type metadata for TASK.

Task is a FOLDER-backed markdown asset, modelled on ``skill``: its ``asset_ref``
is the ``tasks/<name>/`` folder, ``task.md`` is the main doc, and an inner
``spec.md`` (the plan/issue content) rides along as a plain file. ``owns_main_ref``
is True (like ``spec``): the entity is the source of truth for its fields, so
every save re-renders ``task.md`` from ``_task_default_body`` and the generic
reindex reads it back — no bespoke JSON manifest, no bespoke share packer.
"""
from __future__ import annotations

import json
from typing import Any

from flow_sdk.fs_store.indexer.functions._asset_identity import IDENTITY_CAPSULE, capsule_identity, folder_capsule_id
from flow_sdk.fs_store.indexer.functions.task import (
    TASK_FRONTMATTER_FIELDS,
    extract_task,
    task_asset_hash,
    task_id_from_folder,
)
from flow_sdk.schema.type_info import TypeMetadata, render_entity_frontmatter
from flow_sdk.schema.types import EntityType
from flow_sdk.schema.view_mode import ViewMode

# The frontmatter written to ``task.md`` = the canonical round-trip field set
# (single source of truth, shared with the reader ``extract_task``) plus the
# explicitly-handled ``title``/``status``. This doubles as the SHARE WHITELIST:
# sharing copies the folder verbatim, and sender-local keys (``my_process_id`` /
# ``project_root`` / ``project_id`` / ``project_name``) are absent from the set,
# so a received task is runnable and maps its own local project. ``description``
# is rendered as the body; ``id`` is stamped by ``render_entity_frontmatter``.
_TASK_WRITE_FIELDS = {"title", "status", *TASK_FRONTMATTER_FIELDS}


def _plain_description(desc: Any) -> str:
    """Human-readable body text from the entity's ``description``.

    ``description`` may be a plain string (new tasks) or a Lexical-JSON blob
    (legacy) — render Lexical to markdown (headings/lists/tables preserved), and
    never dump raw JSON into the body.
    """
    if not isinstance(desc, str) or not desc.strip():
        return ""
    s = desc.strip()
    if not s.startswith("{"):
        return s
    try:
        data = json.loads(s)
    except json.JSONDecodeError:
        return ""
    if not isinstance(data, dict) or not isinstance(data.get("root"), dict):
        return ""
    from flow_sdk.external_apis.llm.utils.lexical_to_markdown import lexical_to_markdown  # noqa: PLC0415
    return lexical_to_markdown(data).strip()


def _task_default_body(entity) -> str:
    """``task.md`` written to the task's main_ref on create and every save.

    Frontmatter = the share whitelist (non-empty values only); body =
    ``# <title>`` + the plain-text description. The inner ``spec.md`` is NOT
    written here — it is authored separately and rides the folder copy on share.
    """
    fields = entity.model_dump(mode="json", include=_TASK_WRITE_FIELDS, exclude_none=True)
    # Drop empties (yaml ``[]``/``''`` noise); keep the folder clean.
    fields = {k: v for k, v in fields.items() if v not in ("", [], {})}
    title = (getattr(entity, "title", None) or "Untitled task").strip()
    fields["title"] = title
    body = f"\n\n# {title}\n"
    desc = _plain_description(getattr(entity, "description", None))
    if desc:
        body += f"\n{desc}\n"
    return render_entity_frontmatter(entity, fields) + body


TASK = TypeMetadata(
    type=EntityType.TASK,
    icon="CheckSquare",
    browseable_by=ViewMode.STANDARD,
    creatable=True,
    indexed_by_default=True,
    api_visible=True,
    index_fields=["description", "objective"],
    asset_class="repo",
    family="task",
    main_layout="folder",
    main_file="task.md",
    from_disk_fn=extract_task,
    capsules=(IDENTITY_CAPSULE,),
    identity_backend=capsule_identity(folder_capsule_id, task_id_from_folder),
    asset_hash_fn=task_asset_hash,
    default_body_fn=_task_default_body,
    owns_main_ref=True,
    # Sender-local: a received task maps its own local project/worker (project_id
    # is in the base set). Mirrors the frontmatter share whitelist rationale above.
    local_fields=frozenset({"my_process_id", "project_root", "project_name"}),
)
