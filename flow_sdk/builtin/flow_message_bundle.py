"""FlowMessage bundle packing/unpacking.

Bundle format (.flowmsg — a zip file):
  <slug>.flowmsg
  ├── flow_message.json                        (top-level FlowMessage fields; legacy: header.json)
  ├── entities.json                            (portable JSON per involved entity — the metadata axis)
  ├── git_origins.json                         (optional GitOrigin map)
  ├── git_transfers.json                       (optional git-mode transfer map)
  ├── metadata/<type>-<id>/metadata.json       (optional metadata-only entity copy)
  └── attachment/
      ├── spec-<id>/spec.md                    (frontmatter + content)
      ├── task-<id>/header.json                (task fields)
      ├── conversation-<id>/conversation.jsonl (typed Pointer per line)
      ├── flow_message-<id>/header.json        (FlowMessage fields as dict)
      ├── skill-<id>/.claude/skills/<name>/…   (FS-rooted asset subtree)
      └── agent-<id>/.claude/agents/<name>.md  (FS-rooted asset file)

Entry-dir names are the canonical ``<type>-<id>`` stem (``record_stem``). Bundles
produced before the uname-sigil cleanup used ``<type>-@<id>``; unpack reads both.
"""

from __future__ import annotations

import asyncio
import filecmp
import json
import logging
import os
import shutil
import tempfile
import zipfile
from dataclasses import dataclass
from datetime import datetime
from enum import Enum
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING

from flow_sdk.builtin.flow_message import (
    FILE_VFS_PREFIX,
    PROMPT_FILE_VFS_PREFIX,
    AttachmentType,
    is_image_filename,
)
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.fs_store.record_paths import parse_record_stem, record_stem
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)

_FM_FIELDS = {
    "type",
    "id",
    "text",
    "instruction",
    "shared_context_entities",
    "attachment",
    "sender_id",
    "sender_name",
    "receiver_address",
    "receiver_address_type",
    "conversation_id",
    "kind",
    # Wire-meaningful send-time: the receiver preserves it under
    # remote_reflection, so an unpacked message keeps its original
    # timestamp instead of defaulting to now() (which collapsed the
    # conversation's derived recency to the sync instant).
    "created_date",
    "updated_date",
}

# Task is now a folder-backed asset (``main_subdir="tasks"``), so it packs via
# the ONE generic ``_pack_file_backed_attachment`` (the folder — ``task.md`` +
# inner ``spec.md`` — copied verbatim) and receives via the generic staged →
# install → reindex path, exactly like ``skill``. There is no bespoke task
# packer or ``_TASK_FIELDS`` whitelist anymore. The old sender-local strip
# (``my_process_id`` / ``project_root`` / ``project_id`` / ``project_name``) now
# lives in ``_task_default_body``'s frontmatter whitelist (task_type_info.py):
# those keys are never written to ``task.md``, so the verbatim folder copy can't
# leak them and the receiver still allocates its own ``my_process_id`` (runnable
# received task) and maps its own local project.

if TYPE_CHECKING:
    from flow_sdk.builtin.flow_message import FlowMessage

_TRANSFER_MODE_COPY = "copy"
_TRANSFER_MODE_GIT = "git"
_GIT_TRANSFERS_FILE = "git_transfers.json"

# Origin map filename. FSOrigin generalized the git-only origin into a
# kind-tagged pointer; the canonical file is now ``fs_origins.json``. During the
# fleet-upgrade transition we ALSO dual-write the legacy ``git_origins.json``
# (git-kind entries only) so an older receiver — which only knows the legacy
# name — keeps resolving git shares. Readers try the new name, then the legacy.
# The transfers file (``git_transfers.json``) is transfer-STRATEGY metadata, a
# separate axis, and is intentionally left unrenamed.
_FS_ORIGINS_FILE = "fs_origins.json"
_LEGACY_ORIGINS_FILE = "git_origins.json"
# Message-level sender share options (a small side-manifest, like the origin
# maps). Currently just ``{"create_bookmark": bool}`` — the receiver stamps it
# onto each staged MessageAttachment so install can mint a favorite.
_SHARE_OPTIONS_FILE = "share_options.json"
# The portable entity-JSON envelope map: { "<type>-<id>": <common_json> } for
# every involved entity (attachments + best-effort descendants). ALWAYS embedded,
# independent of transfer mode — the metadata axis. The receiver overlays each
# entry onto its materialized row by id (``apply_entities_overlay``).
_ENTITIES_FILE = "entities.json"
# The top-level FlowMessage envelope, renamed from the legacy ``header.json`` for
# clarity (the message is itself an entity). Readers accept both (legacy bundles).
_FLOW_MESSAGE_FILE = "flow_message.json"
_LEGACY_HEADER_FILE = "header.json"
# DB-record types with their own bespoke per-attachment header serializer +
# receive reconstruction (jsonl merge, snapshot merge, file-rewrite, auto-install
# row overrides). They carry their entity JSON via that path, so they are
# excluded from the ``entities.json`` metadata axis (no double-carry, no overlay
# re-applying their sender-local host ids).
_HEADER_SERIALIZED_TYPES = frozenset(
    {
        "conversation",
        "flow_message",
        "flowpad_diagnosis",
        "remote_worker_session",
    }
)


def _is_git_origin_dict(raw) -> bool:
    """A persisted origin dict is git iff its kind is git (or absent — legacy)."""
    from flow_sdk.builtin.fs_origin import DEFAULT_ORIGIN_KIND, resolve_origin_kind  # noqa: PLC0415

    return isinstance(raw, dict) and resolve_origin_kind(raw) == DEFAULT_ORIGIN_KIND


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


class GitShareOriginError(Exception):
    """Raised when an asset explicitly shared in Git mode has no valid Git origin
    at pack time. Fails the share/upload VISIBLY — never silently falls back to
    copying bytes (the sender selected Git; a copy would misrepresent the share).
    The dialog's preflight blocks ineligible assets up front; this is the pack-time
    backstop for an origin that vanished between preflight and packing."""


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
    (tmp_root / _FLOW_MESSAGE_FILE).write_text(
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


async def _pack_flowpad_diagnosis_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/flowpad_diagnosis-@<id>/header.json`` (the recorded
    diagnosis fields).

    Metadata-only entity (no backing source file), so the header IS the record:
    the receiver re-materializes the row via ``.save()`` — the same create-or-
    fill-merge contract as TASK / CLAUDE_SESSION. Without this the forwarded
    diagnosis never transfers, the receiver can't materialize it, and their
    ``body_downloaded`` (hence the Download button) never clears.

    The environment snapshot (``reported_by`` / ``occurred_at`` / ``os`` /
    ``app_version``) is part of the header because the receiver cannot recompute
    it — their machine's OS and version describe the helper, not the reporter.
    ``occurred_at`` is carried instead of ``created_date`` for the same reason:
    the install stamps ``created_date`` locally."""
    from flow_sdk.builtin.flowpad_diagnosis import FlowpadDiagnosis

    diag = await FlowpadDiagnosis.get_one({"id": entry_id})
    if not diag:
        return
    diag_dir = attachment_dir / _entry_key(EntityType.FLOWPAD_DIAGNOSIS.value, entry_id)
    diag_dir.mkdir(parents=True, exist_ok=True)
    diag_data = diag.model_dump(
        mode="python",
        include={
            "id",
            "type",
            "name",
            "title",
            "symptoms",
            "rca",
            "fix",
            "summary",
            "user_report",
            "reported_by",
            "occurred_at",
            "os",
            "app_version",
        },
        context={"skip_api_serializer": True},
    )
    (diag_dir / "header.json").write_text(
        json.dumps(diag_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


async def _pack_remote_worker_session_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/remote_worker_session-@<id>/header.json`` — the
    live-session snapshot.

    Metadata-only entity: the header IS the record, re-materialized on the
    receiver via ``RemoteWorkerSession.apply_snapshot`` (guest adopts
    host-authoritative fields by activity clock; a host row is never
    regressed). Serialized at pack/upload time, so every session message —
    prompts, PromptCompletion replies, SESSION_EVENT lines — ships the session's
    state as of that turn for free. ``host_process_id`` / ``project_id`` are
    host-local (path-leaking) and never travel — the include list is
    ``RemoteWorkerSession.SNAPSHOT_FIELDS``."""
    from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession

    rws = await RemoteWorkerSession.get_one({"id": entry_id})
    if not rws:
        return
    rws_dir = attachment_dir / _entry_key(EntityType.REMOTE_WORKER_SESSION.value, entry_id)
    rws_dir.mkdir(parents=True, exist_ok=True)
    rws_data = rws.model_dump(
        mode="python",
        include=set(RemoteWorkerSession.SNAPSHOT_FIELDS),
        context={"skip_api_serializer": True},
    )
    (rws_dir / "header.json").write_text(
        json.dumps(rws_data, default=_json_default, ensure_ascii=False), encoding="utf-8"
    )


async def _pack_conversation_attachment(
    entry_id: str,
    flow_message: "FlowMessage",
    attachment_dir: Path,
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

    conv_dir = attachment_dir / _entry_key("conversation", entry_id)
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
        "participants": list(conv.members or []),
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
    entry,
    flow_message: "FlowMessage",
    attachment_dir: Path,
    origins: dict | None = None,
    repo_cache: dict | None = None,
    transfers: dict | None = None,
    transfer_mode: str = _TRANSFER_MODE_COPY,
) -> None:
    """Dispatch a single attachment entry to the correct FAMILY packer.

    Three families, not per-type instances:
      - native file (FILE/PROMPT bytes) → ``_pack_file_attachment``.
      - DB-record (no on-disk asset_ref: task/conversation/flow_message/
        claude_session/flowpad_diagnosis) → their header.json serializers.
      - file-backed asset (``TypeInfo.main_subdir is not None``: skill, agent,
        workflow, whiteboard, spec, prompt, markdown, plan, command, rule) →
        the ONE generic ``_pack_file_backed_attachment``.
    URL attachments have no bytes to bundle — silently skipped.
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
    if entry_type == BuiltinEntityType.CONVERSATION.value:
        await _pack_conversation_attachment(entry_id, flow_message, attachment_dir)
    elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
        await _pack_flow_message_entry(entry_id, attachment_dir)
    elif entry_type == EntityType.FLOWPAD_DIAGNOSIS.value:
        await _pack_flowpad_diagnosis_attachment(entry_id, attachment_dir)
    elif entry_type == EntityType.REMOTE_WORKER_SESSION.value:
        await _pack_remote_worker_session_attachment(entry_id, attachment_dir)
    else:
        if await _pack_git_reference_attachment(
            entry_type,
            entry_id,
            attachment_dir,
            origins,
            repo_cache,
            transfers,
            transfer_mode,
        ):
            return
        if await _pack_webapp_artifact_attachment(
            entry_type,
            entry_id,
            attachment_dir,
            transfers,
            transfer_mode,
        ):
            return
        info = SchemaRegistry.get(entry_type)
        if info is not None and getattr(info, "main_subdir", None) is not None:
            await _pack_file_backed_attachment(
                entry_type,
                entry_id,
                attachment_dir,
                origins,
                repo_cache,
                transfers=transfers,
                transfer_mode=transfer_mode,
            )


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


def _entry_key(entry_type: str, entry_id: str) -> str:
    # Canonical self-describing bundle-arc token: <type>-<id> (no uname @).
    return record_stem(entry_type, entry_id)


def _read_file_backed_metadata(entry_type: str, entry_id: str, ent) -> dict:
    """Return the sender's FSRecord metadata payload for a file-backed entity."""
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415

    try:
        record = FSRecord.load(entry_type, entry_id)
        return record.meta_dict()
    except Exception:
        payload = {"type": entry_type, "id": entry_id}
        metadata_payload = getattr(ent, "metadata_payload", None)
        if callable(metadata_payload):
            try:
                payload.update(metadata_payload())
            except Exception:
                pass
        asset_ref = getattr(ent, "asset_ref", None)
        if asset_ref:
            payload["asset_ref"] = str(asset_ref)
        return payload


def _write_git_transfer_metadata(
    tmp_root: Path,
    entry_type: str,
    entry_id: str,
    ent,
) -> str:
    """Write the sender metadata.json copy for a git-mode file-backed entity."""
    key = _entry_key(entry_type, entry_id)
    rel = PurePosixPath("metadata") / key / "metadata.json"
    dest = tmp_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps(_read_file_backed_metadata(entry_type, entry_id, ent), default=_json_default, ensure_ascii=False),
        encoding="utf-8",
    )
    return rel.as_posix()


def _read_graph_entity_metadata(entry_type: str, entry_id: str, ent, strip: tuple[str, ...] = ()) -> dict:
    """Return the sender's graph entity payload for metadata-only git transfer.

    ``strip`` removes machine-local fields that must not travel (e.g. a
    Folder's resolved local ``path`` — the receiver derives its own).
    """
    payload = ent.model_dump(
        mode="python",
        context={"skip_api_serializer": True},
    )
    payload.pop("expand", None)
    for field in strip:
        payload.pop(field, None)
    payload["type"] = entry_type
    payload["id"] = entry_id
    return payload


def _write_graph_git_transfer_metadata(
    tmp_root: Path,
    entry_type: str,
    entry_id: str,
    ent,
    strip: tuple[str, ...] = (),
) -> str:
    key = _entry_key(entry_type, entry_id)
    rel = PurePosixPath("metadata") / key / "metadata.json"
    dest = tmp_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    dest.write_text(
        json.dumps(
            _read_graph_entity_metadata(entry_type, entry_id, ent, strip=strip),
            default=_json_default,
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )
    return rel.as_posix()


async def _resolve_git_reference_origin(ent, stored, repo_cache: dict | None):
    """The GitOrigin to ship for a graph entity: ``stored`` if usable, else a
    LIVE probe of the entity's local ``path``.

    The stored origin goes stale — a directory git-init'd (or given a remote)
    after the entity was minted still carries whatever it had then, and a Folder
    keeps a non-transportable LocalOrigin forever. Preflight probes live, so
    packing must too or the two contradict each other on the same asset. Returns
    None when neither yields a transportable origin; the CALLER owns what that
    means (a folder must fail closed, an artifact falls through to a byte copy).
    """
    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

    if stored is not None and getattr(stored, "transportable", False):
        return stored
    path = getattr(ent, "path", None)
    if not path:
        return None
    live = await asyncio.to_thread(GitOrigin.for_asset_path, str(path), repo_cache)
    return live if live is not None and getattr(live, "transportable", False) else None


async def _pack_git_reference_attachment(
    entry_type: str,
    entry_id: str,
    attachment_dir: Path,
    origins: dict | None,
    repo_cache: dict | None,
    transfers: dict | None,
    transfer_mode: str,
) -> bool:
    """Pack a graph entity whose data is expected to arrive through git.

    This is intentionally narrower than file-backed asset packing. ``artifact``
    and ``folder`` are graph entities, not FSRecord types, so git mode carries
    their metadata and GitOrigin only — zero repository bytes travel, and
    nothing is cloned at pack time. The receiver materializes the row as
    pending and resolves the checkout later through the git wizard/open path
    (artifact: open-artifact → git-setup; folder: the message chip →
    git-context-folder wizard).
    """
    if transfer_mode != _TRANSFER_MODE_GIT or transfers is None:
        return False
    if entry_type not in (EntityType.ARTIFACT.value, EntityType.FOLDER.value):
        return False

    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

    strip_fields: tuple[str, ...] = ()
    if entry_type == EntityType.FOLDER.value:
        from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

        ent = await Folder.get_one({"id": entry_id})
        if ent is None:
            return False
        origin = await _resolve_git_reference_origin(ent, ent.origin, repo_cache)
        if origin is None:
            # Fail closed. Returning False here fell through to a caller that
            # packs NOTHING for a folder (no main_subdir), silently delivering a
            # chip with no origin and no bytes.
            raise GitShareOriginError(
                f"{_entry_key(entry_type, entry_id)} was shared with Git but is not in a "
                f"Git repository with a usable origin — set up Git for this folder first."
            )
        # Self-heal a degenerate name ("" / ".") from before Folder.derive_name
        # existed — repo-root folders were named ".", rendering chips as bare
        # typeids. Persist best-effort so the sender's own chip heals too.
        if (ent.name or "").strip() in ("", "."):
            healed = Folder.derive_name(origin, ent.path)
            if healed:
                ent.name = healed
                try:
                    await ent.save()
                except Exception:
                    logger.debug("[bundle] folder %s name heal failed", entry_id, exc_info=True)
        # The local resolved path is machine-local; the receiver derives its own.
        strip_fields = ("path",)
    else:
        from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

        ent = await Artifact.get_one({"id": entry_id})
        if ent is None:
            return False

        raw_origin = getattr(ent, "origin", None)
        stored = None
        if raw_origin is not None:
            try:
                stored = raw_origin if isinstance(raw_origin, GitOrigin) else GitOrigin.model_validate(raw_origin)
            except Exception:
                stored = None
        origin = await _resolve_git_reference_origin(ent, stored, repo_cache)
        if origin is None:
            # Unlike a folder, an artifact HAS a byte-copy carrier to fall
            # through to (`_pack_webapp_artifact_attachment`), so this is a
            # handoff, not a silent drop.
            return False

    key = _entry_key(entry_type, entry_id)
    if origins is not None:
        origins[key] = origin.model_dump(mode="python")
    metadata_path = _write_graph_git_transfer_metadata(
        attachment_dir.parent,
        entry_type,
        entry_id,
        ent,
        strip=strip_fields,
    )
    transfers[key] = {
        "transfer_mode": _TRANSFER_MODE_GIT,
        "metadata_path": metadata_path,
        "entity_mode": "metadata",
    }
    return True


async def _pack_webapp_artifact_attachment(
    entry_type: str,
    entry_id: str,
    attachment_dir: Path,
    transfers: dict | None,
    transfer_mode: str,
) -> bool:
    """Copy-mode carrier for a folder-backed webapp ``artifact`` with no git remote.

    ``artifact`` is a graph entity (no ``main_subdir``, no walker), so the
    file-backed packer never handles it and the git-reference packer only fires in
    git mode. A Claude-Design-handoff app (a real local folder, not pushed
    anywhere) must ship its BYTES so the receiver can serve it with no clone: the
    folder is copied under ``attachment/<key>/webapps/<slug>/`` and the artifact
    declaration is written as ``metadata/<key>/metadata.json``, recorded in
    ``git_transfers.json`` with ``transfer_mode="copy"`` so the staging loop picks
    it up. The receiver mirrors the folder into the target project and materializes
    the row pointing ``path`` at the served folder (see
    ``_restore_webapp_artifact_entry``). Returns True when it handled the entry.
    """
    if transfer_mode != _TRANSFER_MODE_COPY or transfers is None:
        return False
    if entry_type != EntityType.ARTIFACT.value:
        return False

    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

    ent = await Artifact.get_one({"id": entry_id})
    if ent is None:
        return False
    origin = getattr(ent, "origin", None)
    if getattr(origin, "kind", None) != "local":
        return False
    src = Path(str(origin.base)) / str(origin.rel_path or ".")
    if not src.is_dir():
        return False  # only a folder artifact rides as bytes; nothing to serve otherwise

    key = _entry_key(entry_type, entry_id)
    slug = _safe_entity_name(ent)
    dest = attachment_dir / key / "webapps" / slug
    dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(src, dest, dirs_exist_ok=True, ignore=_pack_ignore(entry_type, src))
    metadata_path = _write_graph_git_transfer_metadata(attachment_dir.parent, entry_type, entry_id, ent)
    transfers[key] = {
        "transfer_mode": _TRANSFER_MODE_COPY,
        "metadata_path": metadata_path,
        "entity_mode": "metadata",
        "slug": slug,
        "bytes_rel": f"webapps/{slug}",
    }
    return True


async def _pack_file_backed_attachment(
    entry_type: str,
    entry_id: str,
    attachment_dir: Path,
    origins: dict | None = None,
    repo_cache: dict | None = None,
    *,
    transfers: dict | None = None,
    transfer_mode: str = _TRANSFER_MODE_COPY,
) -> None:
    """Copy a file-backed asset's on-disk subtree into the bundle.

    Bundle layout: ``attachment/<type>-@<id>/<in_bundle_rel>/…`` where
    ``in_bundle_rel`` is the asset's repo-relative ``rel_path`` when the asset
    lives inside a git repo (a ``GitOrigin`` is then recorded in ``origins``),
    else the canonical ``<main_subdir>/<leaf>``. Keying by ``rel_path`` lets the
    receiver mirror the sender's repo layout via the anchor-free restore. The
    leaf name and every capsule byte are preserved from an existing source.

    Build/environment cruft — plus anything the type declares as
    ``pack_exclude`` — is filtered via ``_pack_ignore`` (deep ``.venv``/cache
    trees blow past Windows MAX_PATH on extractall).
    """
    # A TASK chip is a record-carrier (its folder is task.md bookkeeping), not
    # a git-shareable asset. In a git-mode message — the assignment message
    # mixes a member-task chip with origin-only folder chips — the task must
    # ship as BYTES: the receiver has no clone of the sender's repos, and the
    # fail-closed origin guard below would otherwise kill the whole bundle for
    # tasks living outside any repo (e.g. ~/tasks).
    if transfer_mode == _TRANSFER_MODE_GIT and entry_type == BuiltinEntityType.TASK.value:
        transfer_mode = _TRANSFER_MODE_COPY
    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415

    resolved = await _resolve_file_backed_source(entry_type, entry_id)
    if resolved is None:
        return
    info, ent, src_root = resolved
    entry_root = attachment_dir / _entry_key(entry_type, entry_id)
    subdir = entry_root / info.main_subdir

    # Git provenance + placement: when the on-disk asset lives inside a repo,
    # record a GitOrigin and store the subtree keyed by its repo-relative path so
    # the receiver mirrors the sender's layout (else canonical main_subdir/leaf).
    # ``for_asset_path`` runs blocking git subprocesses — keep them off the loop.
    origin = (
        await asyncio.to_thread(GitOrigin.for_asset_path, str(src_root), repo_cache) if src_root is not None else None
    )
    if origin is not None and origins is not None:
        origins[_entry_key(entry_type, entry_id)] = origin.model_dump(mode="python")

    # Fail closed: Git mode was explicitly selected but this on-disk asset has no
    # valid Git origin. Never fall through to the copy path below (that would ship
    # bytes under a Git share). Structural / no-source entries (src_root is None)
    # are not Git-shareable assets and are handled by the render path.
    if transfer_mode == _TRANSFER_MODE_GIT and src_root is not None and origin is None:
        raise GitShareOriginError(
            f"{_entry_key(entry_type, entry_id)} was shared with Git but is not in a "
            f"Git repository with a usable origin — turn Git sharing off for this asset."
        )

    if transfer_mode == _TRANSFER_MODE_GIT and origin is not None and src_root is not None and transfers is not None:
        key = _entry_key(entry_type, entry_id)
        metadata_path = _write_git_transfer_metadata(
            attachment_dir.parent,
            entry_type,
            entry_id,
            ent,
        )
        transfers[key] = {
            "transfer_mode": _TRANSFER_MODE_GIT,
            "metadata_path": metadata_path,
        }
        return

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
        _mint_rendered_asset_identity(info, dest, entry_type, entry_id)
        return

    # Origin present → key by repo-relative path (mirror sender layout); else the
    # canonical <main_subdir>/<leaf>. The restore is anchor-free, so the in-bundle
    # relpath IS the receiver's placement relpath under the project root.
    dest = (entry_root / PurePosixPath(origin.rel_path)) if origin is not None else (subdir / src_root.name)
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src_root.is_dir():
        shutil.copytree(src_root, dest, dirs_exist_ok=True, ignore=_pack_ignore(entry_type, src_root))
    else:
        shutil.copy2(src_root, dest)


def _mint_rendered_asset_identity(info, body_path: Path, entry_type: str, entry_id: str) -> str:
    """Persist identity for a source-less body through the type's sole seam.

    Existing-source bundles never call this helper: their files and folder
    capsules are copied byte-for-byte. A rendered fallback is newly
    materialized, so TypeInfo may safely persist the proposed bundle id after
    the body exists (``AssetCapsule.from_path`` accepts existing paths only).
    """
    from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    if info.main_layout == "folder":
        asset_path = info.asset_ref_for(body_path.parent)
    else:
        asset_path = body_path
    ref = FSRef(asset_path, record_type=RecordType(entry_type))
    return info.mint_id(ref, proposed_id=entry_id)


def _safe_entity_name(entity) -> str:
    """Filesystem-safe leaf name from an entity's name/title (fallback path)."""
    raw = getattr(entity, "name", None) or getattr(entity, "title", None) or getattr(entity, "id", "asset")
    return "".join(c if c.isalnum() or c in ("-", "_", ".") else "_" for c in str(raw)) or "asset"


def _restore_file_backed_entry(
    entry_dir: Path,
    project_root: Path,
    overwrite: bool,
) -> bool:
    """Copy every file under ``attachment/<type>-@<id>/`` into ``project_root``.

    The in-bundle relpath is already the canonical ``<main_subdir>/<leaf>``
    (the packer stores it that way), so this is an anchor-free verbatim mirror
    — no per-type knowledge. Returns True when ≥1 file was restored. Raises
    ``FlowMessageExistsError`` on a genuine collision when overwrite=False;
    a byte-identical existing file is an idempotent no-op (re-receive).
    """
    from flow_sdk.builtin.git_origin import is_safe_rel_path  # noqa: PLC0415

    conflicts: list[dict] = []
    copied_any = False
    root_resolved = project_root.resolve()
    for src in entry_dir.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(entry_dir)  # "<main_subdir>/<leaf>..." or "<rel_path>/..."
        # Path-traversal guard: the in-bundle relpath is sender-controlled (git
        # origins key the subtree by rel_path). Gate on the SAME named guard the
        # packer uses (anti-drift), then keep the resolve check as defense in depth
        # against symlink escapes a string check can't see.
        dest = project_root / rel
        if not is_safe_rel_path(rel.as_posix()):
            logger.warning("[bundle] skipping unsafe attachment path %s", rel)
            continue
        try:
            dest.resolve().relative_to(root_resolved)
        except ValueError:
            logger.warning("[bundle] skipping unsafe attachment path %s (escapes project root)", rel)
            continue
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


async def _reindex_root(root: Path, record_type, *, types=None, project_id: str | None = None) -> None:
    """Drive ``FSIndexer.index(force=True)`` over a single restored ``root``.

    ``build_default_indexer()`` for the full function registry; the root is
    overridden per-call so we never walk the user's real home dir. ``record_type``
    selects which walkers fire: ``USER_HOME_FOLDER`` for FS-rooted assets
    (``.claude/…``), ``REAL_PROJECT_CWD`` for project-scoped types (``specs/…``).
    ``types`` optionally scopes the materialized set. ``project_id`` is stamped
    onto the root ref so installed rows inherit the chosen project (without
    this every materialized row would land projectless).
    """
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer import IndexerOptions
    from flow_sdk.fs_store.indexer.builtin import build_default_indexer
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415

    # Scope follows the root's ``record_type`` — the FSRef provenance convention
    # (docs/fs-ref.md): USER_HOME_FOLDER → user, REAL_PROJECT_CWD/CWD_ROOT →
    # project, SYSTEM_ROOT → system. This used to hardcode "user", so an
    # install INTO a project walked under a user-scoped root and every row
    # landed scope='user' with project_id set — which project-scoped views
    # (scope in {project, system}) filter out, hiding the asset in the very
    # project it was installed into.
    scope = {
        RecordType.USER_HOME_FOLDER: "user",
        RecordType.REAL_PROJECT_CWD: "project",
        RecordType.CWD_ROOT: "project",
        RecordType.SYSTEM_ROOT: "system",
    }.get(record_type, "user")

    indexer = build_default_indexer()
    await indexer.index(
        IndexerOptions(
            roots=(FSRef(root, record_type=record_type, scope=scope, project_id=project_id),),
            types=types,
            force=True,
            verbose=False,
            # A received asset arrives at a new path carrying the SENDER's id in
            # its capsule — that's an intentional same-id install, NOT a local
            # copy to re-key. Exempt it from dedup-on-adopt (belt-and-suspenders
            # on top of the structural exemption: the sender's local path doesn't
            # exist on the receiver, so it already classifies as a move).
            dedup_on_adopt=False,
        )
    )


async def _reindex_received_assets(project_root: Path, types, *, project_id: str | None = None) -> None:
    """Reindex the project after received file-backed assets were copied in.

    One project-cwd walk scoped to the received types materializes every row
    from its real file (idempotent + body-aware). ``REAL_PROJECT_CWD`` reaches
    all file-backed families; markdown is reached via the FOLDER walker, kept by
    the type-gating since FOLDER → MARKDOWN. ``project_id`` (the conversation's
    owning project) is threaded onto the root ref so received rows are stamped
    with it instead of landing projectless.
    """
    from flow_sdk.fs_store.record_types import RecordType

    await _reindex_root(project_root, RecordType.REAL_PROJECT_CWD, types=tuple(types) or None, project_id=project_id)


async def _reindex_git_origin_scopes(
    project_root: Path,
    received_entries: "set[tuple[str, str]]",
    origins_map: dict,
    *,
    project_id: str | None = None,
) -> None:
    """Reindex each git-origin asset at its repo-relative SCOPE.

    A git-origin asset is placed at ``project_root/<rel_path>`` (mirroring the
    sender's repo layout), which may be NESTED below the project root (e.g.
    ``tools/kit/.claude/skills/foo``). The project-root walk doesn't materialize
    it: the walker IS recursive, but the received reindex prunes ignored ancestor
    directories (``.gitignore`` / the hardcoded ``_WALK_IGNORED`` basenames), and
    force-include only protects paths *under* a ``.claude`` ancestor — not the
    prefix *above* it. So a denied/ignored intermediate dir stops the descent
    before the nested ``.claude`` is reached. Re-rooting the walk at the asset's
    own scope (``project_root`` joined with the rel_path prefix BEFORE
    ``main_subdir``) starts below any pruned ancestor, so the entity (hence the
    git_origin stamp) materializes. A canonical/top-level placement has no prefix
    and is already covered by the project-root walk.
    """
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    scopes: dict[Path, set] = {}
    for entry_type, entry_id in received_entries:
        raw = origins_map.get(_entry_key(entry_type, entry_id))
        if not raw:
            continue
        rel = str(raw.get("rel_path") or "").replace("\\", "/")
        info = SchemaRegistry.get(entry_type)
        main_subdir = getattr(info, "main_subdir", None) if info else None
        if not rel or not main_subdir:
            continue
        # rel_path ends with "<main_subdir>/<leaf>"; the scope is everything above
        # main_subdir. Strip those trailing components structurally (robust to a
        # main_subdir token appearing earlier in the path than a substring search).
        drop = len(PurePosixPath(main_subdir.replace("\\", "/")).parts) + 1  # main_subdir parts + leaf
        rel_parts = PurePosixPath(rel).parts
        prefix_parts = rel_parts[:-drop] if len(rel_parts) > drop else ()
        if not prefix_parts:
            continue  # canonical/top-level — the project-root walk already covers it
        scope = project_root / PurePosixPath(*prefix_parts)
        try:
            scopes.setdefault(scope, set()).add(RecordType(entry_type))
        except ValueError:
            continue
    for scope, types in scopes.items():
        if scope.is_dir():
            await _reindex_root(scope, RecordType.REAL_PROJECT_CWD, types=tuple(types), project_id=project_id)


@dataclass(frozen=True)
class ReceivedAsset:
    """One just-copied file-backed attachment awaiting indexing.

    Carries everything ``index_attachments`` needs per item so the single entry
    point can serve both the interactive install (one item) and any batch
    reception path. ``record_type is None`` ⇒ bytes were copied but there is no
    walker (a raw non-markdown file) — copy-only, no walk. ``git_origin`` set ⇒
    the asset lives at a repo-relative nested scope and its provenance is stamped.
    """

    root: Path
    scope: str  # AttachmentScope value ("user" | "project")
    asset_type: str
    asset_id: str
    entry_key: str
    record_type: object | None = None
    git_origin: dict | None = None


async def index_attachments(attachments: "list[ReceivedAsset]", *, project_id: str | None, owner) -> None:
    """Index a batch of just-copied file-backed attachments — the single reception
    indexer.

    Consolidates the per-attachment reindex block that used to live inline in
    ``handle_attachment_install``: the copy-scope walk (project → ``REAL_PROJECT_CWD``
    via ``_reindex_received_assets``; user → ``USER_HOME_FOLDER`` via
    ``_reindex_root``, now threading ``project_id`` uniformly), the git-origin
    nested-scope re-walk, and the git-origin stamping. It preserves the three
    "don't index here" cases by construction: raw non-markdown files arrive with
    ``record_type=None`` (copy-only); git-**transfer** and git-**reference**
    attachments index via their own restore path and are never passed in.
    """
    from flow_sdk.builtin.message_attachment import AttachmentScope  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    # A repo asset's nested children (of any repo type) ride inside its folder as
    # bytes; widen the reindex to every repo type so the recursive
    # ``agentic-assets`` walker materializes the WHOLE subtree, not just the top
    # asset's type. Non-repo assets keep the tight scope. The widened tuple is
    # constant across items, so build it (and the membership set) once.
    repo_types = set(SchemaRegistry.get_repo_types())
    repo_reindex_types = tuple(RecordType(t) for t in repo_types)

    for item in attachments:
        if item.record_type is not None:
            types = repo_reindex_types if str(item.asset_type) in repo_types else (item.record_type,)
            if item.scope == AttachmentScope.PROJECT.value:
                await _reindex_received_assets(item.root, types, project_id=project_id)
            else:
                await _reindex_root(item.root, RecordType.USER_HOME_FOLDER, types=types, project_id=project_id)
        if item.git_origin:
            origins = {item.entry_key: item.git_origin}
            entries = {(item.asset_type, item.asset_id)}
            if item.scope == AttachmentScope.PROJECT.value:
                await _reindex_git_origin_scopes(item.root, entries, origins, project_id=project_id)
            await _stamp_git_origins(entries, origins, owner)
        await _notify_received_assets({(item.asset_type, item.asset_id)})


def _parse_entry_key(key: str) -> tuple[str, str] | None:
    # Reads both the canonical <type>-<id> and the legacy uname-sigil <type>-@<id>.
    try:
        entry_type, entry_id = parse_record_stem(key or "")
    except ValueError:
        return None
    if not entry_type or not entry_id:
        return None
    return entry_type, entry_id


def _git_origin_asset_root(checkout_root: Path, rel_path: str) -> Path | None:
    from flow_sdk.builtin.git_origin import is_safe_rel_path  # noqa: PLC0415

    if not is_safe_rel_path(rel_path):
        return None
    root = checkout_root.resolve()
    candidate = checkout_root / PurePosixPath(rel_path.replace("\\", "/"))
    try:
        candidate.resolve().relative_to(root)
    except ValueError:
        return None
    return candidate


def _asset_ref_for_git_origin(checkout_root: Path, rel_path: str, info) -> Path | None:
    asset_root = _git_origin_asset_root(checkout_root, rel_path)
    if asset_root is None:
        return None
    if (
        getattr(info, "main_layout", None) == "folder"
        and getattr(info, "main_file_is_asset_ref", False)
        and getattr(info, "main_file", None)
    ):
        return asset_root / info.main_file
    return asset_root


def _git_origin_index_scope(checkout_root: Path, rel_path: str, info) -> Path:
    main_subdir = getattr(info, "main_subdir", None) if info else None
    if not rel_path or not main_subdir:
        return checkout_root
    drop = len(PurePosixPath(main_subdir.replace("\\", "/")).parts) + 1
    rel_parts = PurePosixPath(rel_path.replace("\\", "/")).parts
    prefix_parts = rel_parts[:-drop] if len(rel_parts) > drop else ()
    return checkout_root / PurePosixPath(*prefix_parts) if prefix_parts else checkout_root


def _repo_matches_git_origin(repo_path: Path, origin, *, require_branch: bool = False) -> bool:
    return origin.matches_checkout(repo_path, require_branch=require_branch)


async def _project_id_for_checkout(
    checkout_root: Path,
    *,
    preferred_root: Path | None,
    preferred_project_id: str | None,
) -> str | None:
    try:
        if preferred_root is not None and preferred_project_id:
            if checkout_root.resolve() == preferred_root.resolve():
                return preferred_project_id
    except OSError:
        pass
    try:
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await Project.recover_by_path(str(checkout_root))
        return project.id if project else Project.derive_id_for_path(str(checkout_root))
    except Exception:
        return None


def _next_git_clone_target(origin) -> Path:
    return origin.next_clone_target()


async def _resolve_git_checkout(
    origin,
    *,
    preferred_root: Path | None,
    preferred_project_id: str | None,
) -> tuple[Path, str | None]:
    from flow_sdk.utils.git import find_local_repo_for_url, find_project_root, git_clone, git_pull  # noqa: PLC0415

    candidates: list[Path] = []
    if preferred_root is not None and preferred_root.exists():
        preferred_repo = await asyncio.to_thread(find_project_root, str(preferred_root))
        if preferred_repo and _repo_matches_git_origin(Path(preferred_repo), origin, require_branch=True):
            candidates.append(Path(preferred_repo))

    clone_url = origin.clone_url()
    local_repo = await asyncio.to_thread(find_local_repo_for_url, clone_url)
    if local_repo and _repo_matches_git_origin(Path(local_repo), origin, require_branch=True):
        p = Path(local_repo)
        if p not in candidates:
            candidates.append(p)

    for candidate in candidates:
        if origin.branch:
            ok, msg = await git_pull(str(candidate), branch=origin.branch)
            if not ok:
                logger.info("[bundle] git pull failed for %s: %s", candidate, msg)
        asset_root = _git_origin_asset_root(candidate, origin.rel_path)
        if asset_root is not None and asset_root.exists():
            project_id = await _project_id_for_checkout(
                candidate,
                preferred_root=preferred_root,
                preferred_project_id=preferred_project_id,
            )
            return candidate, project_id

    clone_target = _next_git_clone_target(origin)
    if clone_target.exists() and _repo_matches_git_origin(clone_target, origin):
        project_id = await _project_id_for_checkout(
            clone_target,
            preferred_root=preferred_root,
            preferred_project_id=preferred_project_id,
        )
        return clone_target, project_id
    ok, msg = await git_clone(clone_url, str(clone_target), branch=origin.branch or None)
    if not ok:
        raise RuntimeError(msg)
    project_id = await _project_id_for_checkout(
        clone_target,
        preferred_root=preferred_root,
        preferred_project_id=preferred_project_id,
    )
    return clone_target, project_id


def _read_transfer_metadata(tmp_root: Path, transfer: dict) -> dict:
    rel = str(transfer.get("metadata_path") or "")
    if not rel:
        return {}
    from flow_sdk.builtin.git_origin import is_safe_rel_path  # noqa: PLC0415

    if not is_safe_rel_path(rel):
        return {}
    path = tmp_root / PurePosixPath(rel)
    try:
        path.resolve().relative_to(tmp_root.resolve())
    except ValueError:
        return {}
    try:
        return json.loads(path.read_text(encoding="utf-8")) or {}
    except Exception:
        logger.warning("[bundle] unreadable git transfer metadata at %s", rel, exc_info=True)
        return {}


async def _save_entity_db_only(ent, owner_typeid: str | None) -> None:
    """Persist entity fields without rewriting the file-backed record/FTS row."""
    from flow_sdk.core.entity.entity_model import _SUPPRESS_STORE  # noqa: PLC0415

    token = _SUPPRESS_STORE.set(True)
    try:
        await ent.save(owner_typeid)
    finally:
        _SUPPRESS_STORE.reset(token)


async def _overlay_fields_on_row(ent, patch: dict, owner_typeid: str | None, *, label: str = "") -> None:
    """The shared apply loop: setattr each ``patch`` field (except ``id``/``type``)
    onto a materialized row and persist DB-only. Used by both the git-transfer
    metadata apply and the ``entities.json`` overlay. Skips the save when nothing
    actually changed (the indexer usually already wrote the same values)."""
    fields = getattr(ent.__class__, "model_fields", {}) or {}
    changed = False
    for k, v in patch.items():
        if k in ("id", "type") or not (k in fields or hasattr(ent, k)):
            continue
        try:
            if getattr(ent, k, None) != v:
                setattr(ent, k, v)
                changed = True
        except Exception:
            pass
    if not changed:
        return
    try:
        await _save_entity_db_only(ent, owner_typeid)
    except Exception:
        logger.warning("[bundle] overlay apply failed for %s", label or getattr(ent, "id", ent), exc_info=True)


async def _apply_git_transfer_metadata(
    tmp_root: Path,
    transfer: dict,
    entry_type: str,
    entry_id: str,
    *,
    asset_ref: Path,
    project_id: str | None,
    owner_typeid: str | None,
) -> None:
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    patch = _read_transfer_metadata(tmp_root, transfer)
    patch["type"] = entry_type
    patch["id"] = entry_id
    patch["asset_ref"] = str(asset_ref)
    if project_id:
        patch["project_id"] = project_id
    else:
        patch.pop("project_id", None)

    record = FSRecord(type=entry_type, id=entry_id)
    record.asset_ref = str(asset_ref)
    await asyncio.to_thread(record.save_metadata, patch)

    cls = SchemaRegistry.get_entity_cls(entry_type)
    if cls is None:
        return
    ent = await cls.get_one({"id": entry_id})
    if ent is None:
        return
    await _overlay_fields_on_row(ent, patch, owner_typeid, label=f"{entry_type}-@{entry_id} (git)")


async def _restore_git_transfer_entry(
    tmp_root: Path,
    key: str,
    transfer: dict,
    origins_map: dict,
    *,
    preferred_project_root: Path | None,
    preferred_project_id: str | None,
    overwrite: bool,
    owner_typeid: str | None,
) -> bool:
    from flow_sdk.builtin.fs_origin_driver import get_origin_driver  # noqa: PLC0415
    from flow_sdk.builtin.fs_origin_field import FS_ORIGIN_ADAPTER  # noqa: PLC0415
    from flow_sdk.fs_store.record_types import RecordType  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if not isinstance(transfer, dict) or transfer.get("transfer_mode") != _TRANSFER_MODE_GIT:
        return False
    parsed = _parse_entry_key(key)
    if parsed is None:
        return False
    entry_type, entry_id = parsed
    info = SchemaRegistry.get(entry_type)
    if info is None or getattr(info, "main_subdir", None) is None:
        return False
    raw_origin = origins_map.get(key) or transfer.get("git_origin") or transfer.get("origin")
    if not raw_origin:
        return False
    try:
        origin = FS_ORIGIN_ADAPTER.validate_python(raw_origin)
    except Exception:
        logger.warning("[bundle] invalid transfer origin for %s", key, exc_info=True)
        return False

    # Materialize the bytes to a local path via the kind's driver (git = clone/
    # pull/reuse-local; local = resolve an existing mount). Everything below is
    # origin-kind-agnostic — it operates only on the returned local_root + the
    # universal rel_path.
    local_root, project_id = await get_origin_driver(origin.kind).materialize(
        origin,
        preferred_root=preferred_project_root,
        preferred_project_id=preferred_project_id,
    )
    asset_ref = _asset_ref_for_git_origin(local_root, origin.rel_path, info)
    if asset_ref is None or not asset_ref.exists():
        raise FileNotFoundError(f"transfer asset not found: {local_root / origin.rel_path}")

    cls = SchemaRegistry.get_entity_cls(entry_type)
    existing = await cls.get_one({"id": entry_id}) if cls is not None else None
    existing_asset_raw = (getattr(existing, "asset_ref", "") or "") if existing is not None else ""
    existing_asset = Path(existing_asset_raw) if existing_asset_raw else None
    if existing is not None and existing_asset is not None and not overwrite:
        try:
            same_asset = existing_asset.resolve() == asset_ref.resolve()
        except OSError:
            same_asset = str(existing_asset) == str(asset_ref)
        if not same_asset:
            raise FlowMessageExistsError(
                [
                    {
                        "type": entry_type,
                        "id": entry_id,
                        "path": str(existing_asset),
                    }
                ]
            )

    scope = _git_origin_index_scope(local_root, origin.rel_path, info)
    try:
        record_type = RecordType(entry_type)
    except ValueError:
        return False
    await _reindex_root(scope, RecordType.REAL_PROJECT_CWD, types=(record_type,), project_id=project_id)
    await _apply_git_transfer_metadata(
        tmp_root,
        transfer,
        entry_type,
        entry_id,
        asset_ref=asset_ref,
        project_id=project_id,
        owner_typeid=owner_typeid,
    )
    await _stamp_git_origins({(entry_type, entry_id)}, {key: origin.model_dump(mode="python")}, owner_typeid)
    return True


def _git_origin_from_payload(payload: dict, origins_map: dict, key: str, transfer: dict):
    raw = (
        origins_map.get(key)
        or transfer.get("origin")
        or transfer.get("git_origin")
        or payload.get("origin")
        or payload.get("git_origin")
    )
    if raw is None and isinstance(payload.get("metadata"), dict):
        raw = payload["metadata"].get("origin") or payload["metadata"].get("git_origin")
    if raw is None:
        return None
    from flow_sdk.builtin.fs_origin import FSOrigin  # noqa: PLC0415
    from flow_sdk.builtin.fs_origin_field import FS_ORIGIN_ADAPTER  # noqa: PLC0415

    try:
        return raw if isinstance(raw, FSOrigin) else FS_ORIGIN_ADAPTER.validate_python(raw)
    except Exception:
        logger.warning("[bundle] invalid transfer origin for %s", key, exc_info=True)
        return None


async def _restore_git_reference_entity_entry(
    tmp_root: Path,
    key: str,
    transfer: dict,
    origins_map: dict,
    *,
    overwrite: bool,
    owner_typeid: str | None,
) -> bool:
    """Materialize graph entities whose bytes are supplied by git, not bundle.

    For ``artifact`` we only persist the received declaration and GitOrigin. The
    checkout remains unresolved until the receiver opens the artifact and the
    git setup wizard can provide a local path. For ``folder`` (a git context
    folder chip) we mint the receiver-local Folder from the origin — path
    unset, NO clone — and the message chip's wizard resolves a local checkout
    later.
    """
    if not isinstance(transfer, dict) or transfer.get("transfer_mode") != _TRANSFER_MODE_GIT:
        return False
    parsed = _parse_entry_key(key)
    if parsed is None:
        return False
    entry_type, entry_id = parsed
    if entry_type == EntityType.FOLDER.value:
        from flow_sdk.builtin.folder import Folder  # noqa: PLC0415

        payload = _read_transfer_metadata(tmp_root, transfer)
        origin = _git_origin_from_payload(payload, origins_map, key, transfer)
        if origin is None or not getattr(origin, "transportable", False):
            return False
        # Get-or-create keyed by origin (idempotent — a re-received chip
        # reconciles with an already-minted folder). Local path stays unset.
        folder = await Folder.mint_for_origin(origin)
        if not getattr(folder, "name", None) and payload.get("name"):
            folder.name = payload["name"]
            await folder.save(owner_typeid)
        return True
    if entry_type != EntityType.ARTIFACT.value:
        return False

    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415

    payload = _read_transfer_metadata(tmp_root, transfer)
    origin = _git_origin_from_payload(payload, origins_map, key, transfer)
    if origin is None:
        return False

    payload = {
        "type": entry_type,
        "id": entry_id,
        "name": payload.get("name") or f"artifact-{entry_id[:8]}",
        "kind": payload.get("kind") or "application.web",
        "description": payload.get("description"),
        "origin": origin.model_dump(mode="python"),
    }

    existing = await Artifact.get_one({"id": entry_id})
    if existing is not None and not overwrite:
        existing_origin = _git_origin_from_payload(
            existing.model_dump(mode="python", context={"skip_api_serializer": True}),
            {},
            key,
            {},
        )
        if existing_origin is not None and existing_origin.key() == origin.key():
            if getattr(existing, "origin", None) is None:
                existing.origin = origin
                await existing.save(owner_typeid)
            return True
        raise FlowMessageExistsError(
            [
                {
                    "type": entry_type,
                    "id": entry_id,
                    "path": None,
                }
            ]
        )

    artifact = Artifact.model_validate(payload)
    artifact.id = entry_id
    await artifact.save(owner_typeid)
    return True


async def _restore_webapp_artifact_entry(
    entry_dir: Path,
    project_root: Path,
    transfer: dict,
    unpacked_root: Path,
    *,
    asset_id: str,
    project_id: str | None,
    overwrite: bool,
    owner_typeid: str | None,
) -> Path | None:
    """Install a copy-mode folder webapp artifact: mirror its staged bytes into the
    project and materialize the ``Artifact`` row pointing ``path`` at the served
    folder (no clone).

    The counterpart of ``_pack_webapp_artifact_attachment``. ``entry_dir`` holds
    only ``webapps/<slug>/…`` (the declaration rode separately at
    ``metadata/<key>/metadata.json``), so ``_restore_file_backed_entry`` mirrors it
    verbatim under ``project_root``. Returns the served folder path, or None.
    """
    from flow_sdk.builtin.artifact import Artifact  # noqa: PLC0415
    from flow_sdk.builtin.local_origin import LocalOrigin  # noqa: PLC0415

    slug = str(transfer.get("slug") or "")
    bytes_rel = str(transfer.get("bytes_rel") or (f"webapps/{slug}" if slug else ""))
    if not slug or not bytes_rel:
        return None

    # Mirror the staged webapps/<slug>/ subtree under the project root (anchor-free,
    # verbatim — raises FlowMessageExistsError on a real collision when overwrite=False).
    _restore_file_backed_entry(entry_dir, project_root, overwrite)
    served = project_root / PurePosixPath(bytes_rel)
    if not served.is_dir():
        return None

    # Materialize the row from the shipped declaration — pick only the artifact's
    # own fields (never the sender-local project_id / audit columns).
    payload = _read_transfer_metadata(unpacked_root, transfer)
    new_payload = {
        "type": EntityType.ARTIFACT.value,
        "id": asset_id,
        "name": payload.get("name") or f"artifact-{asset_id[:8]}",
        "kind": payload.get("kind") or "application.web",
        "description": payload.get("description"),
        "origin": LocalOrigin(base=str(served.parent), rel_path=served.name).model_dump(mode="python"),
        "project_id": project_id,
    }

    existing = await Artifact.get_one({"id": asset_id})
    if existing is not None and not overwrite:
        # Idempotent re-receive: heal a missing origin, leave the rest untouched.
        if getattr(existing, "origin", None) is None:
            existing.origin = LocalOrigin(base=str(served.parent), rel_path=served.name)
            await existing.save(owner_typeid)
        return served

    artifact = Artifact.model_validate(new_payload)
    artifact.id = asset_id
    await artifact.save(owner_typeid)
    return served


async def _stamp_git_origins(
    received_entries: "set[tuple[str, str]]",
    origins_map: dict,
    owner_typeid: str | None,
) -> None:
    """Stamp ``git_origin`` on received file-backed entities (best-effort).

    The indexer materialized the rows from disk (preserving the sender's pinned
    id); here we attach the git provenance carried in ``git_origins.json`` so the
    receiver records the asset's upstream repo + repo-relative position. Written
    to the backend record metadata (``persist=TRUE``), never the user-facing file
    and never the hub. Validated through ``GitOrigin`` so a malformed entry is
    dropped rather than persisted raw.
    """
    from flow_sdk.builtin.git_origin import GitOrigin  # noqa: PLC0415
    from flow_sdk.fs_store.fs_record import FSRecord  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    for entry_type, entry_id in received_entries:
        raw = origins_map.get(_entry_key(entry_type, entry_id))
        if not raw:
            continue
        try:
            origin = GitOrigin.model_validate(raw)
        except Exception:
            logger.warning("[bundle] invalid git_origin for %s-@%s; skipping", entry_type, entry_id)
            continue
        cls = SchemaRegistry.get_entity_cls(entry_type)
        if cls is None:
            continue
        ent = await cls.get_one({"id": entry_id})
        if ent is None:
            continue
        origin_payload = origin.model_dump(mode="python")
        try:
            await asyncio.to_thread(
                FSRecord(type=entry_type, id=entry_id).save_metadata_field,
                "git_origin",
                origin_payload,
            )
        except Exception:
            logger.warning(
                "[bundle] failed to persist git_origin metadata on %s-@%s", entry_type, entry_id, exc_info=True
            )
        ent.git_origin = origin_payload
        try:
            await _save_entity_db_only(ent, owner_typeid)
        except Exception:
            logger.warning("[bundle] failed to stamp git_origin on %s-@%s", entry_type, entry_id, exc_info=True)


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


def _attachment_snapshot(entry_dir: Path, entry_type: str) -> "tuple[str | None, str | None]":
    """Best-effort (name, description) for a staged attachment's chip/modal.

    Taken from the bundle at unpack time so the staged MessageAttachment can
    render without the asset entity existing locally: leaf folder/file name,
    refined by the main document's YAML frontmatter when present.
    """
    from flow_sdk.fs_store.indexer._frontmatter import _extract_frontmatter, _yaml_load  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    info = SchemaRegistry.get(entry_type)
    main_file = getattr(info, "main_file", None) if info else None
    # Early-stop lookups (no full-tree listing): an attachment carrying a large
    # resource tree must not be walked whole on the sync path.
    main_path = None
    name: str | None = None
    if main_file:
        main_path = next((p for p in entry_dir.rglob(main_file) if p.is_file()), None)
        if main_path is not None:
            name = main_path.parent.name
    if main_path is None:
        main_path = next((p for p in entry_dir.rglob("*.md") if p.is_file()), None)
        if main_path is not None:
            name = main_path.stem
    if name is None:
        first = next((p for p in entry_dir.rglob("*") if p.is_file()), None)
        if first is not None:
            name = first.stem
    description: str | None = None
    if main_path is not None:
        try:
            fm_text = _extract_frontmatter(main_path.read_text(encoding="utf-8", errors="replace"))
            meta = _yaml_load(fm_text) if fm_text else None
            if isinstance(meta, dict):
                name = str(meta.get("name") or meta.get("title") or name or "") or name
                raw_desc = meta.get("description")
                if raw_desc:
                    description = str(raw_desc)
        except Exception:  # noqa: BLE001 — snapshot is cosmetic, never abort unpack
            pass
    return name, description


async def _stage_attachment(
    *,
    top_fm_id: str,
    conversation_id: "str | None",
    entry_key: str,
    entry_type: str,
    entry_id: str,
    unpacked_path: str,
    name: "str | None",
    description: "str | None",
    git_origin: "dict | None",
    git_transfer: "dict | None" = None,
    transfer_mode: str = "copy",
    user_scope_allowed: "bool | None" = None,
    create_bookmark: bool = False,
    owner_typeid=None,
):
    """Upsert the MessageAttachment row for one staged bundle entry.

    Deterministic id ⇒ a re-download refreshes the snapshot fields while
    PRESERVING install state (scope/project_id/installed_root/installed_at).
    Saved with notify=False — CREATE data_ops are batched after the
    FlowMessage/Conversation sync (see ``_notify_staged_attachments``).

    ``user_scope_allowed`` — when given, overrides the schema-derived policy
    (raw ``file`` entries have no TypeInfo to derive it from, and are always
    user-installable under ``~/.claude``).
    """
    from flow_sdk.builtin.message_attachment import MessageAttachment, TransferMode  # noqa: PLC0415
    from flow_sdk.fs_store.placement import (  # noqa: PLC0415
        user_scope_allowed as user_scope_allowed_policy,
    )
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    ma_id = MessageAttachment.allocate_deterministic_id(top_fm_id, entry_key)
    existing = await MessageAttachment.get_one({"id": ma_id})
    ma = existing or MessageAttachment(id=ma_id)
    ma.flow_message_id = top_fm_id
    if conversation_id:
        ma.conversation_id = conversation_id
    ma.asset_type = entry_type
    ma.asset_id = entry_id
    ma.name = name
    ma.description = description
    ma.unpacked_path = unpacked_path
    ma.transfer_mode = transfer_mode
    ma.git_origin = git_origin
    ma.git_transfer = git_transfer
    ma.create_bookmark = create_bookmark
    # Schema-derived, stamped ONCE here so the UI never re-encodes the policy
    # (the install action re-enforces it through the same predicate).
    if user_scope_allowed is not None:
        ma.user_scope_allowed = user_scope_allowed
    else:
        info = SchemaRegistry.get(entry_type)
        asset_class = info._resolved_layout[0] if info else None
        ma.user_scope_allowed = user_scope_allowed_policy(asset_class, is_git=transfer_mode == TransferMode.GIT.value)
    await ma.save(owner_typeid, notify=False)
    return ma


# ---------------------------------------------------------------------------
# Raw FILE attachment staging (the OS-file-picker lane)
# ---------------------------------------------------------------------------

# A raw file attached via the File picker (attachment_type=file) is NOT an
# asset entity — it has no TypeInfo/main_subdir/RecordType. To let it ride the
# same staged→review→install lifecycle as asset entries, unpack synthesizes a
# per-file ``file-@<id>`` entry dir whose in-bundle relpath is the canonical
# install layout, so ``_restore_file_backed_entry`` (anchor-free verbatim
# mirror) and the scoped reindex work unchanged.
#
# An untyped file follows its ``FSOrigin`` when the attachment carries one (so the
# receiver's tree mirrors the sender's repo); otherwise it falls back by class —
# markdown to ``docs/``, anything else to the project root. Both are owned by
# ``placement.untyped_rel_subdir``. Non-markdown still has no dedicated walker, so
# it is copied but not auto-indexed — it is at least visible and git-tracked now,
# which the old ``.claude/files/`` was not.
_MARKDOWN_SUFFIXES = frozenset({".md", ".markdown"})
# Videos the bubble renders inline as a card — no staged chip. Images use the
# shared ``is_image_filename`` predicate (single source of truth for pictures).
_INLINE_VIDEO_SUFFIXES = frozenset({".mp4", ".webm", ".mov", ".m4v", ".ogg"})


def is_markdown_filename(filename: str) -> bool:
    return PurePosixPath(filename).suffix.lower() in _MARKDOWN_SUFFIXES


def file_attachment_rel_subdir(filename: str, *, origin: object | None = None) -> str:
    """Install-layout subdir for an untyped file, mirrored in its staged entry dir.

    Delegates to ``placement.untyped_rel_subdir`` — the single owner of that
    layout — so stage-time and install-time can never disagree. ``origin``, when
    the attachment carries one, puts the file back at its position in the sender's
    tree; without one the fallback is ``docs/`` for markdown, the project root
    otherwise."""
    from flow_sdk.fs_store.placement import untyped_rel_subdir  # noqa: PLC0415

    return untyped_rel_subdir(filename, origin=origin)


def _should_stage_file_attachment(filename: str) -> bool:
    if is_image_filename(filename) or PurePosixPath(filename).suffix.lower() in _INLINE_VIDEO_SUFFIXES:
        return False  # renders inline as an image/video card
    return True


async def _stage_file_attachments(
    msg_data: dict,
    tmp_root: Path,
    top_fm_id: str,
    staging_conv_id: "str | None",
    owner_typeid,
) -> list:
    """Stage each raw FILE attachment as a MessageAttachment row.

    Reads the FILE sources from ``attachment/files/<name>`` in the extracted
    tree (BEFORE ``_rewrite_file_attachments`` rewrites the paths) and copies
    them into a synthesized ``unpacked/attachment/file-@<id>/<subdir>/<name>``
    entry dir under the message's staging area. Deterministic id ⇒ a re-unpack
    upserts the same row, preserving install state. Images/videos and
    transcripts are skipped (see ``_should_stage_file_attachment``)."""
    from flow_sdk.api.api_types.identifier import mint_uuid  # noqa: PLC0415
    from flow_sdk.fs_store.operations import flow_message as fm_data_ops  # noqa: PLC0415
    from flow_sdk.fs_store.placement import untyped_fallback_class, user_scope_allowed  # noqa: PLC0415

    staged: list = []
    for att in msg_data.get("attachment", []) or []:
        if not isinstance(att, dict):
            continue
        if att.get("attachment_type") != AttachmentType.FILE.value:
            continue
        rel = att.get("data") or ""
        if not rel.startswith("attachment/files/"):
            continue
        src = tmp_root / rel
        if not src.is_file():  # is_file() is already False for a missing path
            continue
        filename = src.name
        if not _should_stage_file_attachment(filename):
            continue
        asset_id = mint_uuid(f"flow_message_file:{top_fm_id}:{filename}")
        entry_key = _entry_key("file", asset_id)
        # Synthesize the entry dir under the persisted staging tree, laid out
        # at the canonical install relpath so install mirrors it verbatim.
        entry_dir = fm_data_ops.staged_entry_dir(top_fm_id, entry_key)
        dest = entry_dir / file_attachment_rel_subdir(filename) / filename
        dest.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dest)
        ma = await _stage_attachment(
            top_fm_id=top_fm_id,
            conversation_id=staging_conv_id,
            entry_key=entry_key,
            entry_type="file",
            entry_id=asset_id,
            unpacked_path=fm_data_ops.staged_entry_rel_path(entry_key),
            name=filename,
            description=None,
            git_origin=None,
            transfer_mode="copy",
            # There's no TypeInfo for 'file', so the class comes from the filename
            # and the ONE policy owner answers from it: a markdown doc is
            # user-installable (``~/docs``), untyped bytes are project-only —
            # a bare file dropped in the user's home is never a sane destination.
            user_scope_allowed=user_scope_allowed(untyped_fallback_class(filename)),
            owner_typeid=owner_typeid,
        )
        staged.append(ma)
    return staged


async def _notify_staged_attachments(mas: list) -> None:
    """Announce staged MessageAttachments to the live UI (one CREATE each).

    Same channel + rationale as ``_notify_received_assets``, but announcing the
    in-hand rows directly (no by-id re-fetch): rows were saved notify=False
    during unpack; the chips' query subscription needs a CREATE to flip
    Download → staged. Fired AFTER the FM CREATE / Conversation UPDATE so the
    message bubble exists before its chips re-render.
    """
    from flow_sdk.api.api_types.messages import DataOpMessage, OperationType  # noqa: PLC0415

    for ma in mas:
        try:
            op = DataOpMessage(data=ma, op=OperationType.CREATE, to_entity=ma.typeid)
            await ma.add_entity_op_notification(op, notify_immediately=True)
        except Exception:
            logger.exception("[bundle] notify CREATE failed for message_attachment %s", ma.id)


# Build/environment artifacts that must never ride inside a shared asset
# bundle. They are regenerable cruft, not skill source, and their deeply
# nested trees (a `.venv` ships `…/site-packages/pip/_internal/…/__pycache__/
# *.pyc`) blow past Windows' 260-char MAX_PATH on the receiver's extractall —
# which silently aborts the whole download. Keep this in sync with the spirit
# of a `.gitignore`: ship source, not built environments.
# Build/environment cruft — type-agnostic, never worth shipping.
_ASSET_PACK_PATTERNS: tuple[str, ...] = (
    ".venv",
    "venv",
    "env",
    "__pycache__",
    "*.pyc",
    "*.pyo",
    "node_modules",
    ".git",
    ".mypy_cache",
    ".pytest_cache",
    ".ruff_cache",
)
_ASSET_PACK_IGNORE = shutil.ignore_patterns(*_ASSET_PACK_PATTERNS)


def _pack_ignore(type_name: str | None, root: Path | str):
    """The copytree filter for a folder-backed asset of ``type_name``.

    Global cruft everywhere, plus that type's ``TypeInfo.pack_exclude`` — per-type
    file policy is declared on the type, not branched on at this call site. A
    task's inner ``spec.md`` (the plan) is the motivating case: the folder is
    copied verbatim, so without this the plan rode along with every share.

    ``pack_exclude`` applies ONLY at the asset folder's own root, never deeper.
    A nested CHILD ENTITY can have the same filename — a ``spec`` entity parented
    to a task is literally a ``spec.md``, one level down under the task's folder —
    and dropping that would break the bundle's nested-entity contract (it did:
    ``test_bundle_entity_envelope_matrix`` caught it). Root-only keeps the
    distinction the filename alone can't carry: the task's own plan vs somebody
    else's entity that happens to live inside.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    extra = tuple(getattr(SchemaRegistry.get(type_name), "pack_exclude", ()) or ()) if type_name else ()
    if not extra:
        return _ASSET_PACK_IGNORE
    root_str = str(root)
    at_root = shutil.ignore_patterns(*_ASSET_PACK_PATTERNS, *extra)

    def _ignore(src_dir, names):
        return (at_root if str(src_dir) == root_str else _ASSET_PACK_IGNORE)(src_dir, names)

    return _ignore


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


def _normalize_transfer_mode(transfer_mode: str | None) -> str:
    mode = (transfer_mode or _TRANSFER_MODE_COPY).strip().lower()
    if mode not in {_TRANSFER_MODE_COPY, _TRANSFER_MODE_GIT}:
        raise ValueError(f"Unsupported bundle transfer_mode: {transfer_mode!r}")
    return mode


# ---------------------------------------------------------------------------
# entities.json — the metadata axis. One portable-JSON envelope per involved
# entity (attachments + best-effort descendants), always embedded, overlaid onto
# the receiver's rows regardless of how the body traveled.
# ---------------------------------------------------------------------------


async def _collect_attachment_envelopes(entry, entities: dict) -> None:
    """Add ``to_common_json()`` for a TYPE_ID attachment entity + its nested
    repo descendants into ``entities`` (keyed ``<type>-<id>``). Best-effort:
    anything missed is recovered by the receiver's natural indexing.

    Scoped to FILE-BACKED / repo assets — the family whose entity JSON was being
    dropped in copy mode. The header-serialized DB-record types (conversation,
    flow_message, claude_session, flowpad_diagnosis, remote_worker_session) carry
    their own envelope + bespoke receive reconstruction, so they are NOT
    double-carried here (that would let the overlay re-apply their sender-local
    host ids — cwd/worker_session_id/host_process_id — over the receive-local
    overrides)."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    if entry.attachment_type != AttachmentType.TYPE_ID:
        return
    tid = TypeId(entry.data)
    entry_type, entry_id = tid.type, tid.id
    if not entry_type or not entry_id:
        return
    if entry_type in _HEADER_SERIALIZED_TYPES:
        return
    cls = SchemaRegistry.get_entity_cls(entry_type)
    if cls is None:
        return
    ent = await cls.get_one({"id": entry_id})
    if ent is None:
        return
    try:
        entities[f"{entry_type}-{entry_id}"] = ent.to_common_json()
    except Exception:
        logger.debug("[bundle] to_common_json failed for %s-%s", entry_type, entry_id, exc_info=True)
    await _collect_descendant_envelopes(entry_type, ent, entities)


async def _collect_descendant_envelopes(entry_type: str, ent, entities: dict) -> None:
    """Walk a folder-backed entity's on-disk subtree for nested repo assets and
    add each one's ``to_common_json()``. Best-effort (wrapped)."""
    try:
        from flow_sdk.fs_store.fs_ref import FSRef  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.functions.repo_assets import repo_assets_fn  # noqa: PLC0415
        from flow_sdk.fs_store.indexer.index_function import IndexerOptions, ref_typeid  # noqa: PLC0415
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        info = SchemaRegistry.get(entry_type)
        ar = getattr(ent, "asset_ref", None)
        if info is None or not ar or info.main_layout != "folder":
            return
        folder = info.folder_for(Path(ar))
        if not folder.is_dir():
            return
        for ref in repo_assets_fn([FSRef(folder)], IndexerOptions()):
            key = ref_typeid(ref)  # <type>-<id>, shared resolver
            if key is None:
                continue
            ccls = SchemaRegistry.get_entity_cls(str(ref.record_type))
            if ccls is None:
                continue
            try:
                cent = await ccls.get_one({"id": key.split("-", 1)[1]})
                if cent is not None:
                    entities[key] = cent.to_common_json()
            except Exception:
                continue
    except Exception:
        logger.debug("[bundle] descendant envelope collection skipped for %s", entry_type, exc_info=True)


def _read_entities_map(unpacked_root: Path) -> dict:
    """Read the bundle's ``entities.json`` map (empty if absent/unreadable)."""
    data = _read_json(unpacked_root / _ENTITIES_FILE, {})
    return data if isinstance(data, dict) else {}


async def apply_entities_overlay(unpacked_root: Path, owner_typeid: str | None) -> None:
    """Overlay every ``entities.json`` envelope onto its materialized row by id.

    The metadata axis of receive: after bodies land + the tree is indexed, the
    portable entity JSON (parent_type_id, labels, status, …) is applied on top of
    what the indexer rebuilt from the body. Sender-local fields never travel
    (stripped at pack via ``to_common_json``), so the receiver's own
    scope/project_id/asset_ref — set by the indexer — are left intact. Entries
    whose row does not exist yet (another attachment, not installed) are skipped;
    the overlay is idempotent."""
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    for key, common in _read_entities_map(unpacked_root).items():
        if not isinstance(common, dict):
            continue
        entry_type, _, entry_id = key.partition("-")
        if not entry_type or not entry_id:
            continue
        cls = SchemaRegistry.get_entity_cls(entry_type)
        if cls is None:
            continue
        try:
            ent = await cls.get_one({"id": entry_id})
        except Exception:
            continue
        if ent is None:
            continue  # row not materialized yet — skip (idempotent)
        await _overlay_fields_on_row(ent, common, owner_typeid, label=key)


async def pack_bundle(
    flow_message: "FlowMessage",
    dest_dir: Path | None = None,
    *,
    transfer_mode: str = _TRANSFER_MODE_COPY,
    create_bookmark: bool = False,
) -> Path:
    """Build a .flowmsg zip from a FlowMessage entity. Returns the zip path.

    File-backed assets that live inside a git repo on the sender contribute a
    ``GitOrigin`` to the top-level ``git_origins.json`` map (keyed by the asset
    typeid). Those entries are stored in the bundle keyed by their repo-relative
    ``rel_path`` so the receiver mirrors the sender's repo layout; assets with no
    git origin keep the canonical ``<main_subdir>/<leaf>`` layout.

    ``transfer_mode='git'`` switches git-backed file-backed assets to metadata-
    only transfer: the bundle carries ``git_origins.json`` + ``git_transfers.json``
    + the sender's ``metadata.json`` copy, and the receiver indexes from the git
    checkout instead of copying asset bytes out of the bundle.
    """
    transfer_mode = _normalize_transfer_mode(transfer_mode)
    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_pack_"))
    try:
        _write_top_level_header(flow_message, tmp_root)
        attachment_dir = tmp_root / "attachment"
        attachment_dir.mkdir()
        # The metadata axis: every involved entity's portable JSON, collected into
        # one root ``entities.json`` map — ALWAYS embedded, regardless of how the
        # body travels (embedded/git). The receiver overlays these onto its rows.
        entities: dict = {}
        # type-@id -> GitOrigin dict; populated by file-backed packing when the
        # asset resolves to a git repo. Written once at the top level. ``repo_cache``
        # memoizes per-repo git reads so co-shared assets from one checkout probe once.
        origins: dict[str, dict] = {}
        transfers: dict[str, dict] = {}
        repo_cache: dict = {}
        for entry in flow_message.attachment:
            await _pack_attachment_entry(
                entry,
                flow_message,
                attachment_dir,
                origins,
                repo_cache,
                transfers=transfers,
                transfer_mode=transfer_mode,
            )
            await _collect_attachment_envelopes(entry, entities)
        if entities:
            (tmp_root / _ENTITIES_FILE).write_text(
                json.dumps(entities, default=_json_default, ensure_ascii=False), encoding="utf-8"
            )
        if origins:
            (tmp_root / _FS_ORIGINS_FILE).write_text(
                json.dumps(origins, default=_json_default, ensure_ascii=False), encoding="utf-8"
            )
            # Transition dual-write: legacy receivers only read git_origins.json.
            # Non-git kinds never go in the legacy file (an old receiver can't
            # materialize them anyway and would mis-handle the entry).
            legacy_origins = {k: v for k, v in origins.items() if _is_git_origin_dict(v)}
            if legacy_origins:
                (tmp_root / _LEGACY_ORIGINS_FILE).write_text(
                    json.dumps(legacy_origins, default=_json_default, ensure_ascii=False),
                    encoding="utf-8",
                )
        if transfers:
            (tmp_root / _GIT_TRANSFERS_FILE).write_text(
                json.dumps(transfers, default=_json_default, ensure_ascii=False), encoding="utf-8"
            )
        if create_bookmark:
            (tmp_root / _SHARE_OPTIONS_FILE).write_text(
                json.dumps({"create_bookmark": True}, ensure_ascii=False), encoding="utf-8"
            )
        return _zip_bundle(tmp_root, dest_dir, flow_message.id)
    finally:
        shutil.rmtree(tmp_root, ignore_errors=True)


async def _pack_flow_message_entry(fm_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/flow_message-@<id>/header.json`` (idempotent)."""
    from flow_sdk.builtin.flow_message import FlowMessage

    fm_dir = attachment_dir / _entry_key("flow_message", fm_id)
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


def _read_json(path: Path, default):
    """Read + parse a JSON file, returning ``default`` if it is missing or
    unreadable. The one raw-JSON-read primitive for the bundle module."""
    if not path.is_file():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return default


def _read_entity_header(entity_dir: Path) -> dict | None:
    """Read the entity's ``header.json`` descriptor, or None if missing/invalid."""
    return _read_json(entity_dir / "header.json", None)


def _read_top_level_header(tmp_root: Path) -> dict | None:
    """Read the top-level FlowMessage envelope: prefer ``flow_message.json`` (new),
    fall back to legacy ``header.json`` so already-received / in-flight bundles
    still open (first existing file wins)."""
    if (tmp_root / _FLOW_MESSAGE_FILE).is_file():
        return _read_json(tmp_root / _FLOW_MESSAGE_FILE, None)
    return _read_json(tmp_root / _LEGACY_HEADER_FILE, None)


def _read_task_md_header(entry_dir: Path) -> dict | None:
    """Read a staged task's ``task.md`` frontmatter → flat field dict.

    The generic file-backed packer stores the folder under
    ``attachment/task-@<id>/tasks/<name>/task.md``. Locate that inner doc, then
    delegate the parse to the one canonical task frontmatter reader."""
    task_md = next(entry_dir.glob("tasks/*/task.md"), None) or next(entry_dir.rglob("task.md"), None)
    if task_md is None:
        return None
    from flow_sdk.fs_store.indexer.functions.task import _read_task_md_fields  # noqa: PLC0415

    fields = _read_task_md_fields(task_md)
    return fields or None


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
) -> "FlowMessage":
    """Extract .flowmsg into the message's STAGING area, return FlowMessage.

    File-backed assets (skill, agent, workflow, whiteboard, spec, prompt,
    markdown, plan, command, rule) and git-transfer assets are NOT copied into
    any project or indexed here. The extracted tree persists under the
    FlowMessage's record-data dir (``download/`` + ``unpacked/`` — see
    ``fs_store/operations/flow_message.py``) and each such attachment is
    represented by a staged ``MessageAttachment`` row (scope=None). The user
    reviews and explicitly installs via the ``message_attachment`` install
    action — that is where copy + reindex (today's restore primitives) run.
    Consent boundary: nothing a sender ships becomes live for agents (skills,
    commands, rules, repo clones) without an explicit install.

    Git-REFERENCE artifacts still materialize their DB row here: that writes no
    filesystem state and no agent work area — resolving the checkout is already
    an explicit wizard step on open.

    Row-only PAYLOAD types with ``TypeInfo.receive_policy == "auto"``
    (claude_session, flowpad_diagnosis) are staged like every payload entry
    and then installed IMMEDIATELY through ``handle_attachment_install`` —
    'auto' waives the review gate for passive, non-executable content, not the
    pipeline. TRANSPORT entries (conversation, its flow_messages,
    remote_worker_session snapshots) are not attachments at all — they are the
    message plumbing itself and always materialize here. TASK additionally
    materializes a slim row for the conversation branch, but its chip state
    follows the MessageAttachment (staged until reviewed+installed).

    Raises ``FlowMessageExistsError`` on a FLOW_MESSAGE header conflict when
    overwrite=False.
    """
    from flow_sdk._compat import UTC
    from flow_sdk.app.actions.notification_scanner import (
        _create_conversation_from_disk,
    )
    from flow_sdk.builtin.conversation import Conversation
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.task import Task
    from flow_sdk.builtin.user import User

    tmp_root = Path(tempfile.mkdtemp(prefix="flowmsg_unpack_"))
    try:
        # 1. Extract zip. On Windows, anchor extraction at an extended-length
        # (``\\?\``) path so members whose full path exceeds the 260-char
        # MAX_PATH still extract instead of raising FileNotFoundError mid-way
        # (which would silently abort the whole unpack). Hardening in depth —
        # the packer already strips the deep `.venv`/cache trees that used to
        # trip this; this keeps a legitimately-deep asset from breaking a share.
        def _extract() -> None:
            with zipfile.ZipFile(zip_path, "r") as zf:
                zf.extractall(_extended_length_path(tmp_root))

        # Off-thread: a multi-MB bundle extraction on the sync path must not
        # stall the event loop (same rationale as the indexer's I/O-to-threads).
        await asyncio.to_thread(_extract)

        # 2. Read the top-level FlowMessage envelope (new: flow_message.json;
        #    legacy bundles: header.json).
        msg_data = _read_top_level_header(tmp_root)
        if msg_data is None:
            raise ValueError("Invalid .flowmsg: missing flow_message.json/header.json")
        msg_data.pop("expand", None)  # strip transient field before validation

        # Resolve owner
        local_user = await User.get_one({"uname": "local"})
        owner_typeid = local_user.typeid if local_user else None

        # Resolve the top-level FM id EARLY — the staging dirs are keyed by it.
        top_fm_id = msg_data.get("id") or FlowMessage.allocate_id(msg_data)

        # Persist the bundle into the message's record-data dir: raw zip under
        # download/, extracted tree under unpacked/ (the STAGING area install
        # reads from later). rmtree-then-copy makes a re-download an atomic
        # refresh of staging; install state lives on MessageAttachment rows,
        # not in these folders, so it survives.
        from flow_sdk.builtin.flow_message import BODY_FILENAME as _BODY_FILENAME  # noqa: PLC0415
        from flow_sdk.fs_store.operations import flow_message as fm_data_ops  # noqa: PLC0415

        def _canonicalize_arcs() -> None:
            """Back-compat: rename any legacy ``<type>-@<id>`` entry dir (from a
            bundle produced before the uname-sigil cleanup) to the canonical
            ``<type>-<id>``, so the persisted staging, ``unpacked_path``, and the
            installer's recomputed ``record_stem`` all agree on the same key."""
            for sub in ("attachment", "metadata"):
                d = tmp_root / sub
                if not d.is_dir():
                    continue
                for entry in list(d.iterdir()):
                    if not entry.is_dir():
                        continue
                    parsed = _parse_entry_key(entry.name)
                    if parsed is None:
                        continue
                    canonical = _entry_key(*parsed)
                    target = entry.parent / canonical
                    if canonical != entry.name and not target.exists():
                        entry.rename(target)

        _canonicalize_arcs()

        def _persist_staging() -> None:
            dl_dir = fm_data_ops.download_dir(top_fm_id)
            dl_dir.mkdir(parents=True, exist_ok=True)
            shutil.copy2(zip_path, dl_dir / _BODY_FILENAME)
            staged_root = fm_data_ops.unpacked_dir(top_fm_id)
            shutil.rmtree(staged_root, ignore_errors=True)
            shutil.copytree(tmp_root, staged_root)

        await asyncio.to_thread(_persist_staging)

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
            BuiltinEntityType.CONVERSATION.value: 2,
            BuiltinEntityType.FLOW_MESSAGE.value: 3,
        }

        def _entry_sort_key(p: Path) -> int:
            try:
                t, _ = parse_record_stem(p.name)
            except ValueError:
                t = ""
            return _TYPE_ORDER.get(t, 99)

        conversation_id: str | None = None
        task_id: str = ""
        from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

        # The conversation this bundle belongs to (best-effort, for stamping
        # conversation_id on the staged MessageAttachment rows so the UI can
        # query them per conversation). No project is resolved here anymore —
        # staging needs none; install resolves its target explicitly.
        staging_conv_id = (msg_data.get("conversation_id") or "").strip() or next(
            (
                TypeId(c).id
                for c in (msg_data.get("shared_context_entities") or [])
                if TypeId(c).type == BuiltinEntityType.CONVERSATION.value
            ),
            None,
        )
        # If the receiver already bound this conversation to a local project
        # (picked one for an earlier attachment), every attachment in it — now
        # and later — installs straight into that project instead of staying
        # staged / user-scoped. Best-effort: a lookup miss falls back to the
        # unbound staging path.
        bound_project_id = None
        if staging_conv_id:
            try:
                _bound_conv = await Conversation.get_one({"id": staging_conv_id})
                bound_project_id = getattr(_bound_conv, "project_id", None) or None
            except Exception:
                logger.warning(
                    "[unpack] bound-project lookup failed for conv %s; staging unbound",
                    staging_conv_id,
                    exc_info=True,
                )
        staged_mas: list = []

        # Git provenance/placement map (type-@id -> GitOrigin dict). Optional; only
        # present when the sender packed assets that lived inside a git repo. Used
        # to (a) place assets at their repo-relative path — already encoded in the
        # bundle layout by the packer — and (b) stamp ``git_origin`` on the
        # materialized receiver entities after reindex.
        # Origin map: prefer the canonical fs_origins.json, fall back to the
        # legacy git_origins.json (old sender). Values are kind-tagged FSOrigin
        # dicts (a legacy dict with no ``kind`` reads as git downstream).
        git_origins_map: dict = {}
        for _origins_name in (_FS_ORIGINS_FILE, _LEGACY_ORIGINS_FILE):
            _go_path = tmp_root / _origins_name
            if _go_path.exists():
                try:
                    git_origins_map = json.loads(_go_path.read_text(encoding="utf-8")) or {}
                    break
                except Exception:
                    logger.warning("[bundle] unreadable %s; ignoring", _origins_name, exc_info=True)

        git_transfers_map: dict = {}
        _gt_path = tmp_root / _GIT_TRANSFERS_FILE
        if _gt_path.exists():
            try:
                git_transfers_map = json.loads(_gt_path.read_text(encoding="utf-8")) or {}
            except Exception:
                logger.warning("[bundle] unreadable %s; ignoring", _GIT_TRANSFERS_FILE, exc_info=True)

        # Message-level sender share options (currently: create_bookmark). Stamped
        # onto each staged MessageAttachment so install can mint a favorite.
        create_bookmark = False
        _so_path = tmp_root / _SHARE_OPTIONS_FILE
        if _so_path.exists():
            try:
                _share_opts = json.loads(_so_path.read_text(encoding="utf-8")) or {}
                create_bookmark = bool(_share_opts.get("create_bookmark"))
            except Exception:
                logger.warning("[bundle] unreadable %s; ignoring", _SHARE_OPTIONS_FILE, exc_info=True)

        # Every git-transfer entry (file-backed asset OR graph artifact) is STAGED
        # like a file-backed asset — nothing materializes at download; the row +
        # any favorite are gated behind an explicit install.
        for key, transfer in sorted(git_transfers_map.items()):
            parsed = _parse_entry_key(key)
            if parsed is None:
                continue
            # Git-TRANSFER entry (file-backed asset OR a graph artifact). STAGED —
            # the clone/pull (file-backed) or the graph-row materialize (artifact)
            # runs inside the explicit install action, not at download.
            entry_type, entry_id = parsed
            gt_payload = _read_transfer_metadata(tmp_root, transfer)
            raw_origin = git_origins_map.get(key) or (transfer or {}).get("git_origin")
            # The transfers manifest carries both git transfers AND copy-mode
            # webapp-artifact byte carriers. Honor the per-entry mode: git points
            # unpacked_path at the metadata file; copy points it at the staged
            # bytes dir (attachment/<key>/) and forces project-only install (a
            # webapp can't live under ~/.claude).
            _tmode = (transfer or {}).get("transfer_mode") or "git"
            if _tmode == _TRANSFER_MODE_COPY:
                _unpacked = fm_data_ops.staged_entry_rel_path(key)
                _user_scope: bool | None = False
            else:
                _unpacked = str(transfer.get("metadata_path") or "")
                _user_scope = None
            staged_mas.append(
                await _stage_attachment(
                    top_fm_id=top_fm_id,
                    conversation_id=staging_conv_id,
                    entry_key=key,
                    entry_type=entry_type,
                    entry_id=entry_id,
                    unpacked_path=_unpacked,
                    name=(gt_payload.get("name") or None),
                    description=(gt_payload.get("description") or None),
                    git_origin=raw_origin if isinstance(raw_origin, dict) else None,
                    git_transfer=transfer if isinstance(transfer, dict) else None,
                    transfer_mode=_tmode,
                    user_scope_allowed=_user_scope,
                    create_bookmark=create_bookmark,
                    owner_typeid=owner_typeid,
                )
            )

        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir(), key=_entry_sort_key):
                if not entry_dir.is_dir():
                    continue
                name = entry_dir.name
                parsed = _parse_entry_key(name)
                if parsed is None:
                    continue
                entry_type, entry_id = parsed

                # FILE-BACKED ASSET FAMILY (TypeInfo.main_subdir set): one branch
                # for skill/agent/workflow/whiteboard/spec/prompt/markdown/plan/
                # command/rule. STAGED — the subtree already persists under the
                # message's unpacked/ dir; record a MessageAttachment row so the
                # UI can review + explicitly install (copy + reindex live in the
                # install action, not here).
                info = SchemaRegistry.get(entry_type)
                if info is not None and getattr(info, "main_subdir", None) is not None:
                    if name in git_transfers_map:
                        continue  # staged above as a git-transfer attachment
                    snap_name, snap_desc = _attachment_snapshot(entry_dir, entry_type)
                    file_ma = await _stage_attachment(
                        top_fm_id=top_fm_id,
                        conversation_id=staging_conv_id,
                        entry_key=name,
                        entry_type=entry_type,
                        entry_id=entry_id,
                        unpacked_path=fm_data_ops.staged_entry_rel_path(name),
                        name=snap_name,
                        description=snap_desc,
                        git_origin=(git_origins_map.get(name) or None),
                        create_bookmark=create_bookmark,
                        owner_typeid=owner_typeid,
                    )
                    staged_mas.append(file_ma)
                    # TASK rides the generic staged→install→reindex path like any
                    # folder asset, BUT a collaboration bundle also carries a
                    # CONVERSATION whose branch (below) wants the Task row to exist
                    # for its perm-dir slug + chip resolution. Install/reindex runs
                    # later, so materialize a slim row NOW from the staged
                    # ``task.md`` frontmatter. Sender-local keys never travel in
                    # ``task.md`` (the whitelist in ``_task_default_body``), so
                    # there is nothing to re-strip. project_id stays receiver-null;
                    # the mapping dialog stamps the local project.
                    if entry_type == BuiltinEntityType.TASK.value:
                        task_data = _read_task_md_header(entry_dir)
                        if task_data is not None:
                            task_id = task_data.get("id") or entry_id
                            bundle_sender_email = task_data.get("sender_email") or ""
                            bundle_sender_name = task_data.get("sender_name") or None
                            if bundle_sender_email:
                                await User.get_or_create_by_email(bundle_sender_email, name=bundle_sender_name)
                            task_payload = {
                                **task_data,
                                "id": task_id,
                                "title": task_data.get("title", ""),
                                "status": task_data.get("status", "to_do"),
                                "spec_type": task_data.get("spec_type") or None,
                                "project_id": None,
                                # DOWNLOADED carries NO scope — the install
                                # action stamps the chosen user/project scope
                                # (docs/collab/messages-and-attachments.md §6).
                                # Declared explicitly so the save chokepoint
                                # honors it instead of deriving 'user' from the
                                # phantom user-home placement of a row that is
                                # never written to disk.
                                "scope": None,
                            }
                            existing_task = await Task.get_one({"id": task_id})
                            if existing_task is None or overwrite:
                                await _save_entity_db_only(Task.model_validate(task_payload), owner_typeid)
                            elif _fill_merge_entity(
                                existing_task,
                                task_payload,
                                ("id", "type", "project_id", "status"),
                            ):
                                await _save_entity_db_only(existing_task, owner_typeid)
                    # Conversation already bound to a project → install this
                    # attachment straight in instead of leaving it staged.
                    if bound_project_id and file_ma.id:
                        from flow_sdk.app.actions.message_attachment_action import (  # noqa: PLC0415
                            handle_attachment_install,
                        )

                        _res = await handle_attachment_install(
                            file_ma.id,
                            "project",
                            bound_project_id,
                            overwrite=overwrite,
                            someone_typeid=owner_typeid,
                        )
                        if getattr(_res, "status", None) != "SUCCESS":
                            logger.warning(
                                "[unpack] conv-bound auto-install failed for %s-%s: %s",
                                entry_type,
                                entry_id,
                                getattr(_res, "message", _res),
                            )
                    continue

                if getattr(SchemaRegistry.get(entry_type), "receive_policy", None) == "auto":
                    # Row-only auto payload (claude_session, flowpad_diagnosis):
                    # staged like every payload entry, then installed IMMEDIATELY
                    # through the one install action — 'auto' means "no review
                    # gate", not "skip the pipeline". The row materializes inside
                    # the install (create-or-fill-merge from the staged header,
                    # plus the type's receive_row_overrides — e.g. claude_session
                    # stamps received=True), so chips resolve exactly as before;
                    # project_id stays null and scope inherits live via the
                    # parent-chain fallback (Entity.effective_project_id).
                    header = _read_entity_header(entry_dir) or {}
                    ma = await _stage_attachment(
                        top_fm_id=top_fm_id,
                        conversation_id=staging_conv_id,
                        entry_key=name,
                        entry_type=entry_type,
                        entry_id=entry_id,
                        unpacked_path=fm_data_ops.staged_entry_rel_path(name),
                        name=header.get("name") or header.get("title"),
                        description=None,
                        git_origin=None,
                        create_bookmark=create_bookmark,
                        owner_typeid=owner_typeid,
                        user_scope_allowed=True,
                    )
                    staged_mas.append(ma)
                    from flow_sdk.app.actions.message_attachment_action import (  # noqa: PLC0415
                        handle_attachment_install,
                    )

                    # A conversation bound to a project claims its auto payloads
                    # too; otherwise they install user-scoped as before.
                    _auto_scope, _auto_pid = ("project", bound_project_id) if bound_project_id else ("user", None)
                    res = await handle_attachment_install(
                        ma.id,
                        _auto_scope,
                        _auto_pid,
                        overwrite=overwrite,
                        someone_typeid=owner_typeid,
                    )
                    if getattr(res, "status", None) != "SUCCESS":
                        logger.warning(
                            "[unpack] auto-install failed for %s-%s: %s",
                            entry_type,
                            entry_id,
                            getattr(res, "message", res),
                        )

                elif entry_type == EntityType.REMOTE_WORKER_SESSION.value:
                    # Live-session snapshot: materialize/refresh the local
                    # session row from the packed header, hub-free. Merge
                    # discipline lives in ``apply_snapshot`` — a host row is
                    # never regressed by an inbound snapshot; a guest row
                    # adopts host-authoritative fields only when the
                    # snapshot's activity clock is fresher.
                    rws_data = _read_entity_header(entry_dir)
                    if rws_data is not None:
                        from flow_sdk.builtin.remote_worker_session import RemoteWorkerSession  # noqa: PLC0415
                        from flow_sdk.cli.app_config import get_user as _get_cloud_user  # noqa: PLC0415

                        rws_id = rws_data.get("id") or entry_id
                        existing_rws = await RemoteWorkerSession.get_one({"id": rws_id})
                        cloud_uid = (_get_cloud_user() or {}).get("id")
                        local_is_host = bool(
                            (existing_rws is not None and getattr(existing_rws, "host_process_id", None))
                            or (cloud_uid and rws_data.get("host_user_id") == cloud_uid)
                        )
                        rws = RemoteWorkerSession.apply_snapshot(
                            existing_rws,
                            {**rws_data, "id": rws_id},
                            local_is_host=local_is_host,
                        )
                        await rws.save(owner_typeid)

                elif entry_type == BuiltinEntityType.CONVERSATION.value:
                    jsonl_file = entry_dir / "conversation.jsonl"
                    if jsonl_file.exists():
                        task_id_for_conv = (
                            next(
                                (
                                    TypeId(c).id
                                    for c in msg_data.get("shared_context_entities", [])
                                    if TypeId(c).type == BuiltinEntityType.TASK.value
                                ),
                                None,
                            )
                            or task_id
                        )
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
                        import re as _re

                        from flow_sdk.instance_settings import get_instance_settings

                        task_obj = await Task.get_one({"id": task_id_for_conv}) if task_id_for_conv else None
                        task_title_slug = (
                            _re.sub(r"[^a-z0-9]+", "-", (task_obj.title or "task").lower()).strip("-")[:60]
                            if task_obj
                            else "task"
                        )
                        perm_task_dir = (
                            get_instance_settings().tasks_dir
                            / f"{task_title_slug}-{(task_id_for_conv or entry_id)[:8]}"
                        )
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

        # 5. Resolve FILE attachment paths and materialize the top-level FlowMessage
        # via the unified write path. ``materialize_flow_message`` saves the
        # FM, appends a typed Pointer to conversation.jsonl, projects
        # message_ids/message_count, and dispatches WS sync (FM CREATE then
        # Conversation UPDATE) — same sequence every other producer uses.
        from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

        # (top_fm_id was resolved early — the staging dirs are keyed by it.)
        # Stage raw FILE attachments (the OS-file-picker lane) as MessageAttachment
        # rows so they join the same download→review→install flow as asset
        # entities. Runs BEFORE _rewrite_file_attachments, which reads the FILE
        # sources from ``attachment/files/`` in tmp_root and then rewrites their
        # ``data`` to the receiver-side embedded VFS subpath.
        staged_mas.extend(
            await _stage_file_attachments(
                msg_data,
                tmp_root,
                top_fm_id,
                staging_conv_id,
                owner_typeid,
            )
        )
        _rewrite_file_attachments(msg_data, tmp_root, top_fm_id)
        msg_data["id"] = top_fm_id
        if not msg_data.get("conversation_id") and conversation_id:
            msg_data["conversation_id"] = conversation_id
        target_conv_id = conversation_id or next(
            (
                TypeId(c).id
                for c in msg_data.get("shared_context_entities", [])
                if TypeId(c).type == BuiltinEntityType.CONVERSATION.value
            ),
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
            saved_fm = await top_fm.save(owner_typeid)
            await _notify_staged_attachments(staged_mas)
            return saved_fm

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

        # 7. Announce the staged attachments LAST — after the FM CREATE and the
        # Conversation UPDATE above — so the message bubble exists before its
        # chips flip from "Download" to staged. Backfill conversation_id on rows
        # staged before the conversation resolved (lightweight bundles).
        for ma in staged_mas:
            if not getattr(ma, "conversation_id", None) and target_conv_id:
                ma.conversation_id = target_conv_id
                await ma.save(owner_typeid, notify=False)
        await _notify_staged_attachments(staged_mas)
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
