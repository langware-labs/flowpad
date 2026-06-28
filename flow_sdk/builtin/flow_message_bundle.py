"""FlowMessage bundle packing/unpacking.

Bundle format (.flowmsg — a zip file):
  <slug>.flowmsg
  ├── header.json                              (top-level FlowMessage fields)
  └── attachment/
      ├── spec-@<id>/spec.md                   (frontmatter + content)
      ├── task-@<id>/header.json               (task fields)
      ├── conversation-@<id>/conversation.jsonl (typed Pointer per line)
      ├── flow_message-@<id>/header.json       (FlowMessage fields as dict)
      ├── skill-@<id>/.claude/skills/<name>/…  (FS-rooted asset subtree)
      └── agent-@<id>/.claude/agents/<name>.md (FS-rooted asset file)

"""
from __future__ import annotations

import filecmp
import json
import logging
import os
import shutil
import tempfile
import zipfile
from datetime import datetime
from enum import Enum
from pathlib import Path
from typing import TYPE_CHECKING

logger = logging.getLogger(__name__)

from flow_sdk.discovery.notify import send_resource_sync
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.schema.types import EntityType
from flow_sdk.fs_store import SyncOperation
from flow_sdk.fs_store.type_id import TypeId

_FM_FIELDS = {"type", "id", "text", "instruction", "shared_context_entities", "attachment",
              "sender_id", "sender_name", "receiver_address", "receiver_address_type",
              "conversation_id", "kind"}

_TASK_FIELDS = {"type", "id", "title", "description", "status", "task_type",
                "priority", "shared_by_id",
                "due_at", "start_date",
                "project_id", "spec_type",
                "shared_process_id",
                "shared_context_entities",
                "active_form", "analysis_json_path", "analysis_path", "artifacts",
                "branch", "classification_category", "classification_command",
                "classification_path", "classification_title", "command",
                "completed_at", "error_fingerprint", "folder_name", "output_dir",
                "process_id", "project_name", "project_url",
                "recipient_email", "repo_id", "result_uname", "sender_email",
                "sender_name", "session_id", "skill_name", "skill_path",
                "skill_scope", "task_type_label", "team_space_id",
                "worker_session_id"}
# `project_root` and `my_process_id` are intentionally excluded — both are
# sender-side values that mean nothing on the receiver. ``project_root`` is
# the sender's local FS path; ``my_process_id`` is the AgenticProcess id
# of the sender's authoring session. The receiver allocates their own local
# my_process_id the first time they click "Start Claude Code" — and that
# spawn path injects the conversation+spec context as the first instruction,
# which is the whole point of receiving a shared task. Shipping the sender's
# id would short-circuit that flow into an "open existing" branch that
# attaches to a stub of the sender's process locally, with no instruction
# injected. Remote-project provenance (`remote_project_id` /
# `remote_project_name`) lives on the Conversation, not the Task — see
# flow_sdk/builtin/conversation.py.

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage

from flow_sdk.builtin.flow_message import AttachmentType, FILE_VFS_PREFIX, PROMPT_FILE_VFS_PREFIX


def _json_default(obj):
    """JSON serializer that converts Enum members to their values."""
    if isinstance(obj, Enum):
        return obj.value
    return str(obj)


class FlowMessageExistsError(Exception):
    """Raised when an attachment entity already exists and overwrite=False."""

    def __init__(self, conflicts: list[dict]):
        self.conflicts = conflicts  # [{"type": ..., "id": ...}]
        super().__init__(f"FlowMessage entities already exist: {conflicts}")


class FlowMessageNoProjectError(Exception):
    """Raised when a bundle carries file-backed assets but the receiving
    conversation is not mapped to a project, so there is nowhere to copy+index
    them. The caller surfaces "map a project first" and re-downloads once a
    project is selected; the bundle stays extracted (parked) meanwhile."""

    def __init__(self, pending_types: list[str]):
        self.pending_types = pending_types
        super().__init__(f"no project mapped for file-backed assets: {pending_types}")


# ---------------------------------------------------------------------------
# pack_bundle
# ---------------------------------------------------------------------------


def _write_top_level_header(flow_message: "FlowMessage", tmp_root: Path) -> None:
    """Serialize the FlowMessage's own fields to ``<root>/header.json``.

    Binary attachments are stored locally as VFS subpaths (FILE: ``data/<name>``,
    PROMPT-with-file: ``prompt/<name>``) but the receiver locates them at
    ``attachment/files/<basename>`` inside the zip — rewrite the ``data``
    field accordingly so both sides agree. Inline-text PROMPT attachments
    (data is the prompt text, not a VFS path) have no file and pass through.
    """
    msg_data = flow_message.model_dump(
        mode="python",
        include=_FM_FIELDS,
        context={"skip_api_serializer": True},
    )
    for att in msg_data.get("attachment", []):
        raw = att.get("data", "")
        if raw.startswith(FILE_VFS_PREFIX) or raw.startswith(PROMPT_FILE_VFS_PREFIX):
            att["data"] = f"attachment/files/{Path(raw).name}"
    (tmp_root / "header.json").write_text(
        json.dumps(msg_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


def _pack_file_attachment(entry, flow_message: "FlowMessage", attachment_dir: Path) -> None:
    """Copy a binary attachment (FILE or PROMPT-with-file) into ``attachment/files/``.

    The local VFS layout (``data/<name>`` for FILE, ``prompt/<name>`` for
    PROMPT-with-file) tells us whether bytes exist on disk. Inline-text
    PROMPT attachments (no path prefix) are skipped — their text rides on
    header.json. The receiver's ``_rewrite_file_attachments`` re-splits FILE
    vs. PROMPT into ``data/`` / ``prompt/`` based on ``attachment_type``,
    so the zip uses a single ``files/`` dir for both.
    """
    from flow_sdk.storage import get_entity_embedded_storage

    raw = entry.data or ""
    if not (raw.startswith(FILE_VFS_PREFIX) or raw.startswith(PROMPT_FILE_VFS_PREFIX)):
        return
    storage = get_entity_embedded_storage(flow_message.typeid)
    file_path = Path(storage.get_storage_path(raw))
    if not file_path.exists():
        return
    files_dir = attachment_dir / "files"
    files_dir.mkdir(exist_ok=True)
    shutil.copy2(file_path, files_dir / file_path.name)


async def _pack_task_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/task-@<id>/header.json`` (whitelisted Task fields)."""
    from flow_sdk.builtin.task import Task

    task = await Task.get_one({"id": entry_id})
    if not task:
        return
    task_dir = attachment_dir / f"task-@{entry_id}"
    task_dir.mkdir(parents=True, exist_ok=True)
    task_data = task.model_dump(
        mode="python",
        include=_TASK_FIELDS,
        context={"skip_api_serializer": True},
    )
    (task_dir / "header.json").write_text(
        json.dumps(task_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


async def _pack_claude_session_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/claude_session-@<id>/header.json`` (whitelisted
    ClaudeTranscript fields).

    Sender-local fields are stripped: ``cwd`` is the sender's filesystem path
    and ``worker_session_id`` is the sender's AgenticProcess worker — both
    meaningless (and path-leaking) on the receiver. The transcript *content*
    rides separately as the share's FILE attachment; this header materializes
    the entity row so the receiver's chip resolves a real name."""
    from flow_sdk.builtin.claude_session import ClaudeSession

    sess = await ClaudeSession.get_one({"id": entry_id})
    if not sess:
        return
    sess_dir = attachment_dir / f"claude_session-@{entry_id}"
    sess_dir.mkdir(parents=True, exist_ok=True)
    sess_data = sess.model_dump(
        mode="python",
        include={"id", "type", "name", "slug", "message_count"},
        context={"skip_api_serializer": True},
    )
    (sess_dir / "header.json").write_text(
        json.dumps(sess_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


async def _pack_git_branch_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/git_branch-@<id>/header.json`` (whitelisted GitBranch
    fields). The snapshot is self-sufficient: provider/owner/name ride as plain
    fields so the receiver re-mints its local deterministic GitRemote parent —
    the GitRemote row itself is deliberately never packed."""
    from flow_sdk.builtin.git_branch import GitBranch

    branch = await GitBranch.get_one({"id": entry_id})
    if not branch:
        return
    branch_dir = attachment_dir / f"{EntityType.GIT_BRANCH.value}-@{entry_id}"
    branch_dir.mkdir(parents=True, exist_ok=True)
    # parent_type_id is deliberately NOT packed — the receiver re-mints it
    # from provider/owner/name and never trusts a wire parent anyway.
    branch_data = branch.model_dump(
        mode="python",
        include={
            "id", "type", "name", "branch", "head_commit", "taken_at",
            "provider", "owner",
        },
        context={"skip_api_serializer": True},
    )
    (branch_dir / "header.json").write_text(
        json.dumps(branch_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


async def _pack_conversation_attachment(
    entry_id: str, flow_message: "FlowMessage", attachment_dir: Path,
) -> None:
    """Write ``attachment/conversation-@<id>/`` (jsonl + remote-project header)
    plus the current FlowMessage's own entry.

    Only the *current* FlowMessage is packed — prior messages already reached
    the receiver in earlier bundles, and re-shipping them risks reverting
    the receiver's local replies that haven't yet round-tripped.
    """
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.project import Project

    conv = await Conversation.get_one({"id": entry_id})
    if not conv or not conv.data_path:
        return
    jsonl_path = Path(conv.data_path)
    if not jsonl_path.exists():
        return

    conv_dir = attachment_dir / f"conversation-@{entry_id}"
    conv_dir.mkdir(parents=True, exist_ok=True)
    shutil.copy2(jsonl_path, conv_dir / "conversation.jsonl")

    # Header carries the conversation's remote provenance from the receiver's
    # POV: the sender's local ``project_id`` and a snapshot of that Project's
    # name. Receiver stores them as ``remote_project_id`` /
    # ``remote_project_name`` to drive the per-machine remote→local mapping
    # table.
    sender_project_id = conv.project_id or None
    sender_project_name = None
    if sender_project_id:
        proj = await Project.get_one({"id": sender_project_id})
        if proj is not None:
            sender_project_name = proj.name or None
    conv_header = {
        "type": "conversation",
        "id": conv.id,
        "project_id": sender_project_id,
        "project_name": sender_project_name,
        # participants drive the reply-recipient resolver on the receiver side
        # (see _resolve_reply_recipient_email): when there's no Task, the reply
        # routes to the participant whose email isn't the local user's.
        "participants": list(conv.participants or []),
        # User-set display title (NewConversationDialog autofill). Receiver
        # stores it on the local Conversation so both sides render the same row.
        "title": (conv.title or None),
    }
    (conv_dir / "header.json").write_text(
        json.dumps(conv_header, default=_json_default, ensure_ascii=False),
        encoding="utf-8",
    )
    await _pack_flow_message_entry(flow_message.id, attachment_dir)


async def _pack_attachment_entry(
    entry, flow_message: "FlowMessage", attachment_dir: Path,
) -> None:
    """Dispatch a single attachment entry to the correct FAMILY packer.

    Three families, not per-type instances:
      - native file (FILE/PROMPT bytes) → ``_pack_file_attachment``.
      - DB-record (no on-disk asset_ref: task/conversation/flow_message/
        claude_session/git_branch) → their header.json serializers.
      - file-backed asset (``TypeInfo.main_subdir is not None``: skill, agent,
        workflow, whiteboard, spec, prompt, markdown, plan, command, rule) →
        the ONE generic ``_pack_file_backed_attachment``.
    Repo/URL attachments have no bytes to bundle — silently skipped.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if entry.attachment_type in (AttachmentType.FILE, AttachmentType.PROMPT):
        _pack_file_attachment(entry, flow_message, attachment_dir)
        return
    if entry.attachment_type != AttachmentType.TYPE_ID:
        return
    tid = TypeId(entry.data)
    entry_type, entry_id = tid.type, tid.id
    if not entry_type or not entry_id:
        return
    if entry_type == BuiltinEntityType.TASK.value:
        await _pack_task_attachment(entry_id, attachment_dir)
    elif entry_type == BuiltinEntityType.CONVERSATION.value:
        await _pack_conversation_attachment(entry_id, flow_message, attachment_dir)
    elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
        await _pack_flow_message_entry(entry_id, attachment_dir)
    elif entry_type == BuiltinEntityType.CLAUDE_SESSION.value:
        await _pack_claude_session_attachment(entry_id, attachment_dir)
    elif entry_type == EntityType.GIT_BRANCH.value:
        await _pack_git_branch_attachment(entry_id, attachment_dir)
    else:
        info = SchemaRegistry.get(entry_type)
        if info is not None and getattr(info, "main_subdir", None) is not None:
            await _pack_file_backed_attachment(entry_type, entry_id, attachment_dir)


# ---------------------------------------------------------------------------
# File-backed asset packing — ONE family handler for skill, agent, workflow,
# whiteboard, spec, prompt, markdown, plan, command, rule (any type whose
# TypeInfo declares ``main_subdir``). The canonical record is the on-disk
# asset_ref (a file or a folder); pack copies it verbatim under the bundle at
# ``attachment/<type>-@<id>/<main_subdir>/<leaf>`` so the in-bundle relpath
# equals what the receiver's ``compute_asset_ref(project_root, ent)`` produces.
# No per-type code — layout/main_file all come from TypeInfo.
# ---------------------------------------------------------------------------


async def _resolve_file_backed_source(entry_type: str, entry_id: str):
    """Return ``(info, entity, src_root)`` for a file-backed asset, or None.

    ``src_root`` is the on-disk subtree to ship: for a folder type it's the
    folder (the asset_ref itself, or its parent for spec-style where asset_ref
    is the inner main_file); for a file type it's the file. None when the type
    isn't file-backed or the entity/asset can't be located on disk.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(entry_type)
    if info is None or getattr(info, "main_subdir", None) is None:
        return None
    cls = SchemaRegistry.get_entity_cls(entry_type)
    if cls is None:
        return None
    ent = await cls.get_one({"id": entry_id})
    if ent is None:
        return None
    ar = getattr(ent, "asset_ref", None)
    if not isinstance(ar, str) or not ar:
        return (info, ent, None)  # no on-disk source — caller may render a body
    ar_path = Path(ar)
    if not ar_path.exists():
        return (info, ent, None)
    if info.main_layout == "folder":
        # spec-style: asset_ref is the inner main_file → ship the parent folder.
        # skill-style: asset_ref is the folder itself.
        src_root = ar_path.parent if getattr(info, "main_file_is_asset_ref", False) else ar_path
    else:
        src_root = ar_path
    return (info, ent, src_root)


async def _pack_file_backed_attachment(
    entry_type: str, entry_id: str, attachment_dir: Path,
) -> None:
    """Copy a file-backed asset's on-disk subtree into the bundle.

    Bundle layout: ``attachment/<type>-@<id>/<main_subdir>/<leaf>``. The leaf
    name is preserved from the source (not re-slugged) so the round-trip keeps
    the sender's folder/file name. The sender's id is pinned into the main doc
    (``TypeInfo.main_file`` for folder types, the file itself for single-file
    types) so the receiver's ``gen_uuid_fn`` materializes the SAME entity.

    Build/environment cruft is filtered via ``_ASSET_PACK_IGNORE`` (deep
    ``.venv``/cache trees blow past Windows MAX_PATH on extractall).
    """
    resolved = await _resolve_file_backed_source(entry_type, entry_id)
    if resolved is None:
        return
    info, ent, src_root = resolved
    entry_root = attachment_dir / f"{entry_type}-@{entry_id}"
    subdir = entry_root / info.main_subdir

    if src_root is None:
        # No on-disk source — render the body from the type's default_body_fn
        # (covers a DB-backed spec/prompt/markdown whose file was never written).
        default_body_fn = getattr(info, "default_body_fn", None)
        if default_body_fn is None:
            return  # nothing renderable to ship
        safe = _safe_entity_name(ent)
        if info.main_layout == "folder":
            main_file = getattr(info, "main_file", None)
            if not main_file:
                return  # folder type without a main doc: nothing to ship
            dest = subdir / safe / main_file
        else:
            dest = subdir / f"{safe}{info.main_ext}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_text(default_body_fn(ent), encoding="utf-8")
        _ensure_id_in_md_frontmatter(dest, entry_id)
        return

    dest = subdir / src_root.name
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src_root.is_dir():
        shutil.copytree(src_root, dest, dirs_exist_ok=True, ignore=_ASSET_PACK_IGNORE)
        # Pin the id into the folder's main doc (TypeInfo.main_file).
        main_file = getattr(info, "main_file", None)
        if main_file:
            doc = dest / main_file
            if doc.exists():
                _ensure_id_in_md_frontmatter(doc, entry_id)
    else:
        shutil.copy2(src_root, dest)
        # Single-file markdown asset: pin the id into its frontmatter. Skip
        # non-markdown bodies (e.g. dynamic_workflow ``.js``) — no YAML fm there.
        if dest.suffix == ".md":
            _ensure_id_in_md_frontmatter(dest, entry_id)


def _safe_entity_name(entity) -> str:
    """Filesystem-safe leaf name from an entity's name/title (fallback path)."""
    raw = getattr(entity, "name", None) or getattr(entity, "title", None) or getattr(entity, "id", "asset")
    return "".join(c if c.isalnum() or c in ("-", "_", ".") else "_" for c in str(raw)) or "asset"


async def _resolve_project_root_for_conv(conv_id: str) -> "Path | None":
    """The receiver's mapped PROJECT directory for this conversation, or None.

    Received file-backed assets are copied into the conversation's project (the
    UI forces project selection on an incoming share). Mirrors
    ``_resolve_workdir_and_project_async`` (flow_message_action) but keyed off
    the conversation id directly. None ⇒ no project mapped yet (gate the copy).
    """
    if not conv_id:
        return None
    from flow_sdk.builtin.conversation import Conversation  # noqa: PLC0415

    conv = await Conversation.get_one({"id": conv_id})
    if conv is None:
        return None
    # Prefer a context Task's project_root, else the Project's mount path.
    task_typeid = (
        conv.first_context_of_type(BuiltinEntityType.TASK.value)
        if hasattr(conv, "first_context_of_type") else None
    )
    if task_typeid:
        from flow_sdk.builtin.task import Task  # noqa: PLC0415
        task = await Task.get_one({"id": task_typeid.id})
        wd = (getattr(task, "project_root", "") or "").strip() if task else ""
        if wd:
            return Path(wd)
    project_id = getattr(conv, "project_id", None)
    if project_id:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415
        project = await Project.get_one({"id": project_id})
        mount = (getattr(project, "fs_storage_mount_path", "") or "").strip() if project else ""
        if mount:
            return Path(mount)
    return None


def _restore_file_backed_entry(
    entry_dir: Path, project_root: Path, overwrite: bool,
) -> bool:
    """Copy every file under ``attachment/<type>-@<id>/`` into ``project_root``.

    The in-bundle relpath is already the canonical ``<main_subdir>/<leaf>``
    (the packer stores it that way), so this is an anchor-free verbatim mirror
    — no per-type knowledge. Returns True when ≥1 file was restored. Raises
    ``FlowMessageExistsError`` on a genuine collision when overwrite=False;
    a byte-identical existing file is an idempotent no-op (re-receive).
    """
    conflicts: list[dict] = []
    copied_any = False
    for src in entry_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(entry_dir)  # "<main_subdir>/<leaf>..."
        dest = project_root / rel
        if dest.exists() and not overwrite:
            if filecmp.cmp(src, dest, shallow=False):
                continue  # same asset already present — no-op
            conflicts.append({"path": str(dest)})
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        copied_any = True
    if conflicts:
        raise FlowMessageExistsError(conflicts)
    return copied_any


async def _reindex_root(root: Path, record_type, *, types=None) -> None:
    """Drive ``FSIndexer.index(force=True)`` over a single restored ``root``.

    ``build_default_indexer()`` for the full function registry; the root is
    overridden per-call so we never walk the user's real home dir. ``record_type``
    selects which walkers fire: ``USER_HOME_FOLDER`` for FS-rooted assets
    (``.claude/…``), ``REAL_PROJECT_CWD`` for project-scoped types (``specs/…``).
    ``types`` optionally scopes the materialized set.
    """
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import IndexerOptions
    from flow_sdk.fs_store.indexer.builtin import build_default_indexer

    indexer = build_default_indexer()
    await indexer.index(
        IndexerOptions(
            roots=(FSRef(root, record_type=record_type, scope="user"),),
            types=types,
            force=True,
            verbose=False,
        )
    )


async def _reindex_received_assets(project_root: Path, types) -> None:
    """Reindex the project after received file-backed assets were copied in.

    One project-cwd walk scoped to the received types materializes every row
    from its real file (idempotent + body-aware). ``REAL_PROJECT_CWD`` reaches
    all file-backed families; markdown is reached via the FOLDER walker, kept by
    the type-gating since FOLDER → MARKDOWN.
    """
    from flow_sdk.fs_store.record_types import RecordType

    await _reindex_root(project_root, RecordType.REAL_PROJECT_CWD, types=tuple(types) or None)


async def _notify_received_assets(entries: "set[tuple[str, str]]") -> None:
    """Announce just-materialized received assets to the receiver's live UI.

    The FSIndexer persists received-asset rows with ``notify=False`` (correct: a
    bulk index walk must not flood the WS). But a share-receive genuinely
    *creates* a small, known set of entities on this user, and the live page has
    to learn about them — otherwise each asset's conversation chip stays stuck on
    the 404 it negative-cached before the download ("not found locally"),
    un-openable until a manual reload.

    So the importer announces its own imports: one CREATE ``DataOpMessage`` per
    received entity, via the SAME channel ``Entity.save(notify=True)`` uses
    (``add_entity_op_notification`` → ``handle_entity_op`` → WS fanout). It must
    be CREATE, not UPDATE: the receiver never had these cached, and the
    frontend's update/entity-event handlers bail on an uncached entity — only a
    CREATE adds it and wakes the chip's ``useEntity`` subscriber.

    Type-agnostic: entity classes resolve generically through ``SchemaRegistry``,
    so every file-backed family rides this with zero per-type code. ``entries`` is
    a set, so each asset is announced exactly once.
    """
    from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    for entry_type, entry_id in entries:
        try:
            cls = SchemaRegistry.get_entity_cls(entry_type)
            if cls is None:
                continue
            ent = await cls.get_one({"id": entry_id})
            if ent is None:
                continue
            op = DataOpMessage(data=ent, op=OperationType.CREATE, to_entity=ent.typeid)
            await ent.add_entity_op_notification(op, notify_immediately=True)
        except Exception:
            logger.exception("[bundle] notify CREATE failed for %s-%s", entry_type, entry_id)




# Build/environment artifacts that must never ride inside a shared asset
# bundle. They are regenerable cruft, not skill source, and their deeply
# nested trees (a `.venv` ships `…/site-packages/pip/_internal/…/__pycache__/
# *.pyc`) blow past Windows' 260-char MAX_PATH on the receiver's extractall —
# which silently aborts the whole download. Keep this in sync with the spirit
# of a `.gitignore`: ship source, not built environments.
_ASSET_PACK_IGNORE = shutil.ignore_patterns(
    ".venv", "venv", "env", "__pycache__", "*.pyc", "*.pyo",
    "node_modules", ".git", ".mypy_cache", ".pytest_cache", ".ruff_cache",
)


def _inject_id_into_frontmatter_text(text: str, entry_id: str) -> "str | None":
    """Return ``text`` with ``id: <entry_id>`` ensured in its YAML frontmatter
    (other fields + body preserved), or None when the id already matches — so a
    caller can keep the original bytes verbatim. Single source of truth for the
    "carry the sender's id into a shared markdown asset" contract, shared by the
    spec restore and the FS-rooted packer."""
    from flow_sdk.fs_store.indexer._frontmatter import (  # noqa: PLC0415
        _extract_body,
        _extract_frontmatter,
        _render_frontmatter,
        _yaml_load,
    )
    fm = _extract_frontmatter(text)
    fields = (_yaml_load(fm) or {}) if fm else {}
    if not isinstance(fields, dict):
        fields = {}
    if fields.get("id") == entry_id:
        return None
    body = _extract_body(text) if fm else text
    merged = {"id": entry_id, **{k: v for k, v in fields.items() if k != "id"}}
    return _render_frontmatter(merged) + "\n\n" + body.lstrip("\n")


def _ensure_id_in_md_frontmatter(md_path: Path, entry_id: str) -> None:
    """Idempotently ensure a markdown file's YAML frontmatter carries
    ``id: <entry_id>``. No-op when the id already matches; rewrites the file
    with the id injected (preserving other fields + body) otherwise."""
    try:
        text = md_path.read_text(encoding="utf-8")
    except OSError:
        return
    rewritten = _inject_id_into_frontmatter_text(text, entry_id)
    if rewritten is not None:
        md_path.write_text(rewritten, encoding="utf-8")


def _zip_bundle(tmp_root: Path, dest_dir: Path | None, fm_id: str | None) -> Path:
    """Zip ``tmp_root`` contents into ``<dest_dir>/<slug>.flowmsg`` and return the path."""
    short_id = fm_id[:8] if fm_id else "msg"
    slug = f"flow-message-{short_id}"
    if dest_dir is None:
        dest_dir = Path(tempfile.mkdtemp(prefix="flowmsg_zip_"))
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    zip_path = dest_dir / f"{slug}.flowmsg"
    with zipfile.ZipFile(zip_path, "w", zipfile.ZIP_DEFLATED) as zf:
        for file_path in tmp_root.rglob("*"):
            if file_path.is_file():
                zf.write(file_path, file_path.relative_to(tmp_root))
    return zip_path


async def pack_bundle(flow_message: "FlowMessage", dest_dir: Path | None = None) -> Path:
    """Build a .flowmsg zip from a FlowMessage entity. Returns the zip path."""
    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_pack_"))
    try:
        _write_top_level_header(flow_message, tmp_root)
        attachment_dir = tmp_root / "attachment"
        attachment_dir.mkdir()
        for entry in flow_message.attachment:
            await _pack_attachment_entry(entry, flow_message, attachment_dir)
        return _zip_bundle(tmp_root, dest_dir, flow_message.id)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _pack_flow_message_entry(fm_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/flow_message-@<id>/header.json`` (idempotent)."""
    from flow_sdk.builtin.flow_message import FlowMessage

    fm_dir = attachment_dir / f"flow_message-@{fm_id}"
    if fm_dir.exists():
        return
    fm = await FlowMessage.get_one({"id": fm_id})
    if not fm:
        return
    fm_dir.mkdir(parents=True, exist_ok=True)
    fm_data = fm.model_dump(
        mode="python",
        include=_FM_FIELDS,
        context={"skip_api_serializer": True},
    )
    (fm_dir / "header.json").write_text(
        json.dumps(fm_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


def _read_entity_header(entity_dir: Path) -> dict | None:
    """Read the entity's ``header.json`` descriptor, or None if missing/invalid."""
    path = entity_dir / "header.json"
    if not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return None


def _fill_merge_entity(existing, payload: dict, skip_keys: tuple[str, ...]) -> bool:
    """Re-unpack onto an existing row: FILL-MERGE, never skip.

    The bundle header is authoritative for fields the receiver hasn't
    populated; receiver-local state (anything in ``skip_keys``, plus any
    already-set value) is never clobbered. Returns True if anything changed.
    Shared by the TASK and CLAUDE_SESSION unpack branches — the per-type
    variance is the skip list, not the loop."""
    changed = False
    for k, v in payload.items():
        if k in skip_keys or v in (None, "", []):
            continue
        if getattr(existing, k, None) in (None, "", []):
            setattr(existing, k, v)
            changed = True
    return changed


# ---------------------------------------------------------------------------
# _rewrite_file_attachments
# ---------------------------------------------------------------------------


def _rewrite_file_attachments(fm_data: dict, tmp_root: Path, fm_id: str) -> None:
    """Copy binary attachments from the extracted zip into the FlowMessage's embedded
    storage and rewrite their `data` field to the receiver-side VFS subpath.

    FILE attachments land at ``data/<filename>``; PROMPT-with-file attachments
    land at ``prompt/<filename>`` — the same layout the sender uses, so
    ``/fs/download/`` resolves identically on both sides. Inline-text PROMPT
    attachments are passed through.
    """
    from flow_sdk.api.type_id import TypeId
    from flow_sdk.storage import get_entity_embedded_storage
    fm_typeid = TypeId(type="flow_message", id=fm_id)
    storage = get_entity_embedded_storage(fm_typeid)
    for att in fm_data.get("attachment", []):
        att_type = att.get("attachment_type")
        rel_path = att.get("data", "")
        if not rel_path.startswith("attachment/files/"):
            continue
        if att_type == AttachmentType.FILE.value:
            vfs_prefix = FILE_VFS_PREFIX.rstrip("/")
        elif att_type == AttachmentType.PROMPT.value:
            vfs_prefix = PROMPT_FILE_VFS_PREFIX.rstrip("/")
        else:
            continue
        src = tmp_root / rel_path
        if not src.exists():
            continue
        vfs_subpath = f"{vfs_prefix}/{src.name}"
        dest = Path(storage.get_storage_path(vfs_subpath))
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        att["data"] = vfs_subpath


# ---------------------------------------------------------------------------
# _materialize_received_transcripts
# ---------------------------------------------------------------------------

# Worker-session entity types → worker key. A shared session's chip opens its
# transcript *by session id*, resolved against the local CLI dirs; on a
# receiver that never ran the session those are empty, so we persist the
# carried transcript where ``resolve_session_jsonl`` falls back to.
_WORKER_SESSION_TYPES = {
    "claude_session": "claude",
    "codex_session": "codex",
    "copilot_session": "copilot",
}


def _file_contains(path: Path, needle: str) -> bool:
    try:
        return needle in path.read_text(encoding="utf-8", errors="ignore")
    except OSError:
        return False


def _materialize_received_transcripts(fm_data: dict, tmp_root: Path) -> None:
    """Persist any carried worker-session transcript into the instance's
    received-transcripts store, keyed by (worker, session_id).

    The transcript rides in as the share's FILE attachment; copying it to the
    received store makes the by-session-id transcript chip open on a receiver
    that never ran the session — exactly as it does on the sender. No-op when
    the message carries no worker session (the common case) or the sender
    opted not to attach the transcript. Worker-generic (claude/codex/copilot).

    The FILE is paired to its session by matching the session id inside the
    file's content: every worker transcript embeds its own session id, so the
    pairing is unambiguous even when several files ride along.
    """
    from flow_sdk.transcript_analyzer.resolver import received_transcript_dest

    atts = fm_data.get("attachment", []) or []
    sessions: list[tuple[str, str]] = []
    for att in atts:
        if not isinstance(att, dict) or att.get("attachment_type") != AttachmentType.TYPE_ID.value:
            continue
        tid = TypeId(att.get("data") or "")
        worker = _WORKER_SESSION_TYPES.get(tid.type)
        if worker and tid.id:
            sessions.append((worker, tid.id))
    if not sessions:
        return

    file_srcs: list[Path] = []
    for att in atts:
        if not isinstance(att, dict) or att.get("attachment_type") != AttachmentType.FILE.value:
            continue
        rel = att.get("data") or ""
        if rel.startswith("attachment/files/"):
            src = tmp_root / rel
            if src.exists():
                file_srcs.append(src)
    if not file_srcs:
        return

    for worker, sid in sessions:
        dest = received_transcript_dest(worker, sid)
        if dest is None or dest.exists():
            continue
        match = next((f for f in file_srcs if _file_contains(f, sid)), None)
        if match is None:
            continue
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(match, dest)


# ---------------------------------------------------------------------------
# _merge_conversation_jsonl
# ---------------------------------------------------------------------------

def _merge_conversation_jsonl(bundle_jsonl: Path, dest: Path) -> None:
    """Write a merged conversation.jsonl to dest.

    Keeps all existing local pointers in dest, then appends any pointers from
    bundle_jsonl whose target id is not already present (preserving local replies).
    """
    from flow_sdk.fs_store.pointer import Pointer  # noqa: PLC0415

    def _read_ptrs(path: Path) -> list[Pointer]:
        ptrs: list[Pointer] = []
        if not path.exists():
            return ptrs
        for line in path.read_text(encoding="utf-8").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                ptrs.append(Pointer.from_jsonl_line(line))
            except Exception:
                pass
        return ptrs

    existing = _read_ptrs(dest)
    existing_ids = {p.id for p in existing}
    new_ptrs = [p for p in _read_ptrs(bundle_jsonl) if p.id not in existing_ids]
    dest.parent.mkdir(parents=True, exist_ok=True)
    with dest.open("w", encoding="utf-8") as fh:
        for ptr in existing + new_ptrs:
            fh.write(ptr.to_jsonl_line() + "\n")


# ---------------------------------------------------------------------------
# unpack_bundle
# ---------------------------------------------------------------------------

def _extended_length_path(p: Path) -> Path:
    """Return ``p`` as a Windows extended-length (``\\\\?\\``) path so writes
    under it bypass the 260-char MAX_PATH limit. No-op off Windows and when the
    prefix is already present. The prefix requires a fully-qualified,
    backslash-separated path with no ``.``/``..`` components, so resolve first."""
    if os.name != "nt":
        return p
    resolved = os.path.abspath(str(p))
    if resolved.startswith("\\\\?\\"):
        return Path(resolved)
    if resolved.startswith("\\\\"):  # UNC: \\server\share -> \\?\UNC\server\share
        return Path("\\\\?\\UNC" + resolved[1:])
    return Path("\\\\?\\" + resolved)


async def unpack_bundle(
    zip_path: Path,
    local_user_id: str,
    *,
    overwrite: bool = False,
    raise_on_no_project: bool = False,
) -> "FlowMessage":
    """Extract .flowmsg, materialize entities, return FlowMessage.

    File-backed assets (skill, agent, workflow, whiteboard, spec, prompt,
    markdown, plan, command, rule) are copied from the extracted message folder
    into the conversation's mapped PROJECT at ``<project>/<main_subdir>/<leaf>``
    and indexed from there. When the conversation has no project mapped the
    assets are parked (extracted, not copied); ``raise_on_no_project=True``
    (the explicit download path) then raises ``FlowMessageNoProjectError`` AFTER
    the FlowMessage materializes, so the caller can prompt + re-download.

    Raises ``FlowMessageExistsError`` on a genuine asset collision when
    overwrite=False.
    """
    from flow_sdk._compat import UTC
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.task import Task
    from flow_sdk.builtin.user import User
    from flow_sdk.app.actions.notification_scanner import (
        _create_conversation_from_disk,
    )

    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_unpack_"))
    try:
        # 1. Extract zip. On Windows, anchor extraction at an extended-length
        # (``\\?\``) path so members whose full path exceeds the 260-char
        # MAX_PATH still extract instead of raising FileNotFoundError mid-way
        # (which would silently abort the whole unpack). Hardening in depth —
        # the packer already strips the deep `.venv`/cache trees that used to
        # trip this; this keeps a legitimately-deep asset from breaking a share.
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(_extended_length_path(tmp_root))

        # 2. Read top-level header.json
        msg_data = _read_entity_header(tmp_root)
        if msg_data is None:
            raise ValueError("Invalid .flowmsg: missing header.json")
        msg_data.pop("expand", None)  # strip transient field before validation

        # Resolve owner
        local_user = await User.get_one({"uname": "local"})
        owner_typeid = local_user.typeid if local_user else None

        attachment_dir = tmp_root / "attachment"

        # 3. Conflict check: detect if the top-level FlowMessage already exists, but do NOT
        # raise yet — we still need to process attachments (step 4) so the conversation.jsonl
        # is merged and the Conversation entity is updated even on re-unpacks.
        top_fm_id_check = msg_data.get("id")
        top_fm_already_exists = False
        if top_fm_id_check and not overwrite:
            existing_top = await _check_entity_exists(BuiltinEntityType.FLOW_MESSAGE.value, top_fm_id_check)
            if existing_top:
                top_fm_already_exists = True

        # 4. Materialize attachments
        # Process in dependency order: prompt/spec → task → conversation → flow_message
        _TYPE_ORDER = {
            EntityType.PROMPT.value: 0,
            BuiltinEntityType.SPEC.value: 0,
            BuiltinEntityType.TASK.value: 1,
            EntityType.GIT_BRANCH.value: 1,
            BuiltinEntityType.CONVERSATION.value: 2,
            BuiltinEntityType.FLOW_MESSAGE.value: 3,
        }

        def _entry_sort_key(p: Path) -> int:
            t, _, _ = p.name.partition("-@")
            return _TYPE_ORDER.get(t, 99)

        conversation_id: str | None = None
        task_id: str = ""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415
        from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

        # The conversation this bundle belongs to. Its data folder is the
        # internal "message folder" (where the zip extracted); received
        # file-backed assets are copied OUT of here into the conversation's
        # PROJECT and indexed from there. Resolve the receiver's mapped project
        # once: None ⇒ assets are parked (extracted, not copied/indexed) until
        # the user maps a project.
        staging_conv_id = (msg_data.get("conversation_id") or "").strip() or next(
            (TypeId(c).id for c in (msg_data.get("shared_context_entities") or [])
             if TypeId(c).type == BuiltinEntityType.CONVERSATION.value),
            None,
        )
        project_root = await _resolve_project_root_for_conv(staging_conv_id) if staging_conv_id else None
        received_types: set = set()
        received_entries: set[tuple[str, str]] = set()
        no_project_pending: list[str] = []

        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir(), key=_entry_sort_key):
                if not entry_dir.is_dir():
                    continue
                name = entry_dir.name
                entry_type, _, entry_id = name.partition("-@")
                if not entry_type or not entry_id:
                    continue

                # FILE-BACKED ASSET FAMILY (TypeInfo.main_subdir set): one branch
                # for skill/agent/workflow/whiteboard/spec/prompt/markdown/plan/
                # command/rule. Copy the extracted ``<main_subdir>/<leaf>``
                # subtree into the project, reindex the project after the loop.
                info = SchemaRegistry.get(entry_type)
                if info is not None and getattr(info, "main_subdir", None) is not None:
                    if project_root is None:
                        no_project_pending.append(entry_type)
                        continue
                    if _restore_file_backed_entry(entry_dir, project_root, overwrite):
                        try:
                            received_types.add(RecordType(entry_type))
                        except ValueError:
                            pass
                        received_entries.add((entry_type, entry_id))
                    continue

                if entry_type == BuiltinEntityType.TASK.value:
                    task_data = _read_entity_header(entry_dir)
                    if task_data is not None:
                        task_id = task_data.get("id") or entry_id
                        # Materialize the sender as a local User (contact list).
                        bundle_sender_email = task_data.get("sender_email") or ""
                        bundle_sender_name = task_data.get("sender_name") or None
                        if bundle_sender_email:
                            await User.get_or_create_by_email(bundle_sender_email, name=bundle_sender_name)
                        # Note: we do NOT compute a deterministic Project uuid
                        # from the sender's `project_root` here. That path is
                        # the sender's local filesystem and means nothing on
                        # the receiver's machine — we'd just stamp a uuid that
                        # 404s when anyone tries to load the Project. Receiver
                        # picks via the mapping dialog; the picker stamps both
                        # task.project_id and conversation.project_id.
                        existing_task = await Task.get_one({"id": task_id})
                        # Strip sender-local fields that are meaningless on the
                        # receiver: `project_root` is the sender's filesystem
                        # path; `project_name` mirrors the sender's local
                        # Project name; `my_process_id` is the sender's
                        # AgenticProcess id (defense in depth — the pack side
                        # also drops it from `_TASK_FIELDS`, but we re-strip
                        # here so older bundles on the hub and senders running
                        # stale code can't leak it through). Remote provenance
                        # now lives on the Conversation (see CONVERSATION
                        # branch below), not the Task — so we don't propagate
                        # `project_id` / `project_name` onto the receiver's
                        # task either.
                        task_payload = {
                            k: v for k, v in task_data.items()
                            if k not in ("project_root", "project_name", "my_process_id")
                        }
                        task_payload.update({
                            "id": task_id,
                            "title": task_data.get("title", ""),
                            "status": task_data.get("status", "to_do"),
                            "spec_type": task_data.get("spec_type") or None,
                            "project_id": None,
                        })
                        if existing_task is None or overwrite:
                            task = Task.model_validate(task_payload)
                            await task.save(owner_typeid)
                        else:
                            # The old exists-check skip let any earlier partial
                            # row permanently block the bundle's real title /
                            # spec link / process id from ever landing. Skips
                            # protect receiver-local state (project mapping,
                            # status progress).
                            if _fill_merge_entity(
                                existing_task, task_payload,
                                ("id", "type", "project_id", "status"),
                            ):
                                await existing_task.save(owner_typeid)

                elif entry_type == BuiltinEntityType.CLAUDE_SESSION.value:
                    # Shared ClaudeTranscript: materialize the entity row from
                    # the packed header (same create-or-fill-merge contract as
                    # TASK — a partial row never blocks the real name/slug).
                    sess_data = _read_entity_header(entry_dir)
                    if sess_data is not None:
                        from flow_sdk.builtin.claude_session import ClaudeSession  # noqa: PLC0415
                        sess_id = sess_data.get("id") or entry_id
                        # ``received=True``: the transcript rode in with the share
                        # and lives only under received_transcripts/ — it never ran
                        # here and is not resumable. Drives the viewer's resume-hide
                        # + analyze-transcript toolbar.
                        sess_payload = {**sess_data, "id": sess_id, "remote": False, "received": True}
                        existing_sess = await ClaudeSession.get_one({"id": sess_id})
                        if existing_sess is None or overwrite:
                            sess = ClaudeSession.model_validate(sess_payload)
                            await sess.save(owner_typeid)
                        elif _fill_merge_entity(existing_sess, sess_payload, ("id", "type")):
                            await existing_sess.save(owner_typeid)

                elif entry_type == EntityType.GIT_BRANCH.value:
                    # Shared git location snapshot: materialize the deterministic
                    # GitRemote parent FIRST (re-minted from the header's plain
                    # provider/owner/name — the parent never rides as a blob),
                    # then create-or-fill-merge the GitBranch row itself.
                    branch_data = _read_entity_header(entry_dir)
                    if branch_data is not None:
                        from flow_sdk.builtin.git_branch import GitBranch  # noqa: PLC0415
                        branch_id = branch_data.get("id") or entry_id
                        pid = await GitBranch.materialize_share_parent(branch_data, owner_typeid)
                        branch_payload = {**branch_data, "id": branch_id, "remote": False}
                        if pid:
                            branch_payload["parent_type_id"] = pid
                        existing_branch = await GitBranch.get_one({"id": branch_id})
                        if existing_branch is None or overwrite:
                            branch = GitBranch.model_validate(branch_payload)
                            await branch.save(owner_typeid)
                        elif _fill_merge_entity(existing_branch, branch_payload, ("id", "type")):
                            await existing_branch.save(owner_typeid)

                elif entry_type == BuiltinEntityType.CONVERSATION.value:
                    jsonl_file = entry_dir / "conversation.jsonl"
                    if jsonl_file.exists():
                        task_id_for_conv = next(
                            (TypeId(c).id for c in msg_data.get("shared_context_entities", []) if TypeId(c).type == BuiltinEntityType.TASK.value),
                            None,
                        ) or task_id
                        # The bundle's conversation header carries the sender's
                        # local project_id / project_name. The receiver stores
                        # them as the conversation's `remote_project_id` /
                        # `remote_project_name` — provenance for the per-machine
                        # remote→local mapping table.
                        conv_header = _read_entity_header(entry_dir) or {}
                        bundle_remote_project_id = conv_header.get("project_id") or None
                        bundle_remote_project_name = conv_header.get("project_name") or None
                        bundle_participants = conv_header.get("participants") or []
                        bundle_title = (conv_header.get("title") or "").strip() or None
                        # Copy conversation.jsonl to a permanent location before the
                        # temp dir is cleaned up — _create_conversation_from_disk
                        # stores data_path pointing at task_dir, so it must survive.
                        from flow_sdk.instance_settings import get_instance_settings
                        import re as _re
                        task_obj = await Task.get_one({"id": task_id_for_conv}) if task_id_for_conv else None
                        task_title_slug = _re.sub(r"[^a-z0-9]+", "-", (task_obj.title or "task").lower()).strip("-")[:60] if task_obj else "task"
                        perm_task_dir = get_instance_settings().tasks_dir / f"{task_title_slug}-{(task_id_for_conv or entry_id)[:8]}"
                        perm_task_dir.mkdir(parents=True, exist_ok=True)
                        perm_jsonl = perm_task_dir / "conversation.jsonl"
                        _merge_conversation_jsonl(jsonl_file, perm_jsonl)
                        # notify=False — the conversation save would otherwise fire a
                        # sync notification before the referenced FlowMessage is saved
                        # (step 5), causing the UI to fetch a not-yet-saved FM (404).
                        # We send the conversation sync explicitly in step 7 instead.
                        conv = await _create_conversation_from_disk(
                            task_dir=perm_task_dir,
                            task_id=task_id_for_conv or "",
                            conversation_id=entry_id,
                            owner_typeid=owner_typeid,
                            notify=False,
                            project_id=None,
                            remote_project_id=bundle_remote_project_id,
                            remote_project_name=bundle_remote_project_name,
                            participants=bundle_participants,
                            title=bundle_title,
                        )
                        if conv:
                            conversation_id = conv.id
                            # Frontend notification is deferred to step 7 — firing it here
                            # would tell the UI to refetch the conversation before the
                            # referenced FlowMessage is saved (step 5), causing 404s.

                elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
                    fm_data = _read_entity_header(entry_dir)
                    if fm_data is not None:
                        fm_data.pop("expand", None)
                        fm_id = fm_data.get("id") or entry_id
                        existing_fm = await FlowMessage.get_one({"id": fm_id})
                        if existing_fm is not None and not overwrite:
                            continue  # already exists — skip without aborting the whole unpack
                        _rewrite_file_attachments(fm_data, tmp_root, fm_id)
                        inner_fm = FlowMessage.model_validate(fm_data)
                        inner_fm.id = fm_id
                        await inner_fm.save(owner_typeid)

        # 4b. ONE project reindex over the copied file-backed assets so DB rows +
        # FTS5 entries land before any UI sync fires. Scoped to the received
        # types; zero-cost when the bundle carried no file-backed assets.
        if received_types and project_root is not None:
            await _reindex_received_assets(project_root, received_types)
            # The indexer materializes those rows silently (notify=False), so
            # announce the just-created assets to the receiver's live UI — one
            # CREATE data_op each — or their conversation chips stay stuck on the
            # pre-download 404 ("not found locally") until a manual reload.
            await _notify_received_assets(received_entries)

        # 4c. No-project note: file-backed assets were extracted but the
        # conversation isn't mapped to a project, so they were NOT copied/indexed
        # — they stay parked. The FlowMessage still materializes below (the
        # message + its asset chips show); the gate is RAISED at the end so the
        # explicit download path can prompt "map a project first" and
        # re-download, while implicit callers leave it parked.
        if no_project_pending:
            logger.info("[bundle] %d file-backed asset(s) parked — no project mapped for conv=%s",
                        len(no_project_pending), staging_conv_id)

        # 5. Resolve FILE attachment paths and materialize the top-level FlowMessage
        # via the unified write path. ``materialize_flow_message`` saves the
        # FM, appends a typed Pointer to conversation.jsonl, projects
        # message_ids/message_count, and dispatches WS sync (FM CREATE then
        # Conversation UPDATE) — same sequence every other producer uses.
        from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

        top_fm_id = msg_data.get("id") or FlowMessage.allocate_id(msg_data)
        # Persist any carried worker-session transcript BEFORE the rewrite
        # mutates attachment paths — it reads the FILE sources from tmp_root.
        _materialize_received_transcripts(msg_data, tmp_root)
        _rewrite_file_attachments(msg_data, tmp_root, top_fm_id)
        msg_data["id"] = top_fm_id
        if not msg_data.get("conversation_id") and conversation_id:
            msg_data["conversation_id"] = conversation_id
        target_conv_id = conversation_id or next(
            (TypeId(c).id for c in msg_data.get("shared_context_entities", [])
             if TypeId(c).type == BuiltinEntityType.CONVERSATION.value),
            None,
        )
        # Lightweight bundles (no Conversation attachment dir, no
        # shared_context_entities entry) still reference the parent
        # conversation as a TypeId attachment — recover it from there so the
        # FM materializes via the conversation path instead of orphan-saving.
        if not target_conv_id:
            for att in msg_data.get("attachment", []) or []:
                if not isinstance(att, dict):
                    continue
                if att.get("attachment_type") != "type_id":
                    continue
                ref = att.get("data") or ""
                try:
                    tid = TypeId(ref)
                except Exception:
                    continue
                if tid.type == BuiltinEntityType.CONVERSATION.value:
                    target_conv_id = tid.id
                    if not msg_data.get("conversation_id"):
                        msg_data["conversation_id"] = target_conv_id
                    break
        if top_fm_already_exists and not overwrite and not conversation_id:
            raise FlowMessageExistsError([{"type": BuiltinEntityType.FLOW_MESSAGE.value, "id": top_fm_id_check}])
        if not target_conv_id:
            # Bundle has no conversation pointer — fall back to a bare save.
            top_fm = FlowMessage.model_validate(msg_data)
            top_fm.id = top_fm_id
            return await top_fm.save(owner_typeid)

        bundle_ts = msg_data.get("created_date") or datetime.now(UTC).isoformat()
        top_fm = await materialize_flow_message(
            msg_data,
            conversation_id=target_conv_id,
            someone_typeid=owner_typeid,
            bundle_ts=bundle_ts,
            # A .flowmsg bundle is a hub-delivered message; its row mirrors a
            # hub counterpart.
            remote=True,
        )

        # Entity-event channel: useEntity hooks in the UI re-render on this,
        # not just send_resource_sync. Keep the explicit notify in addition to
        # the WS sync materialize_flow_message already dispatched.
        try:
            conv_to_notify = await Conversation.get_one({"id": target_conv_id})
            if conv_to_notify:
                await conv_to_notify.notify_updated()
        except Exception:
            pass

        # No-project gate (raised AFTER the FM materialized): assets are parked
        # until a project is mapped. The explicit download path surfaces this so
        # the UI prompts + re-downloads.
        if no_project_pending and raise_on_no_project:
            raise FlowMessageNoProjectError(no_project_pending)
        return top_fm
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _check_entity_exists(entity_type: str, entity_id: str) -> bool:
    """Return True if an entity of the given type+id already exists in the DB."""
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.spec import Spec
    from flow_sdk.builtin.task import Task

    type_map = {
        BuiltinEntityType.SPEC.value: Spec,
        BuiltinEntityType.TASK.value: Task,
        BuiltinEntityType.CONVERSATION.value: Conversation,
        BuiltinEntityType.FLOW_MESSAGE.value: FlowMessage,
    }
    cls = type_map.get(entity_type)
    if cls is None:
        return False
    result = await cls.get_one({"id": entity_id})
    return result is not None
