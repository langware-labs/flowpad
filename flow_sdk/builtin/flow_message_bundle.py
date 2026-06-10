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

import json
import logging
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


async def _pack_spec_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/spec-@<id>/spec.md`` (frontmatter + content)."""
    from flow_sdk.builtin.spec import Spec

    spec = await Spec.get_one({"id": entry_id})
    if not spec:
        return
    spec_dir = attachment_dir / f"spec-@{entry_id}"
    spec_dir.mkdir(parents=True, exist_ok=True)
    # ``id`` in the frontmatter so the receiver's reindex materializes the SAME
    # entity row (``spec_gen_id`` prefers the frontmatter id over uuid5(path)).
    # Structure unchanged — this is the spec.md content, not the bundle layout.
    fm_lines = ["---\n", f"id: {entry_id}\n", f'title: "{spec.title}"\n', f'spec_type: "{spec.spec_type}"\n', "---\n"]
    spec_md = "".join(fm_lines) + (spec.content or "")
    (spec_dir / "spec.md").write_text(spec_md, encoding="utf-8")


async def _pack_prompt_attachment(entry_id: str, attachment_dir: Path) -> None:
    """Write ``attachment/prompt-@<id>/prompt.md`` (frontmatter + text body).

    Rendered via ``_prompt_default_body`` so the frontmatter (id/name/icon/
    color/use_count/last_used_at) round-trips through ``extract_prompt`` —
    the same write path the entity's own ``owns_main_ref`` save uses.
    """
    from flow_sdk.builtin.prompt import Prompt
    from flow_sdk.schema.type_info.prompt_info import _prompt_default_body

    prompt = await Prompt.get_one({"id": entry_id})
    if not prompt:
        return
    prompt_dir = attachment_dir / f"prompt-@{entry_id}"
    prompt_dir.mkdir(parents=True, exist_ok=True)
    (prompt_dir / "prompt.md").write_text(_prompt_default_body(prompt), encoding="utf-8")


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
    """Dispatch a single attachment entry to the correct per-type packer.

    Repo/URL attachments have no bytes to bundle — silently skipped.

    TODO: at ~10+ branches consider a TypeInfo-driven ``pack_attachment``
    hook instead of growing this dispatch (currently 8: spec, prompt, task,
    conversation, flow_message, claude_session, fs-rooted). Each type has a
    distinct serialization, so the registry hook is the only generic form.
    """
    if entry.attachment_type in (AttachmentType.FILE, AttachmentType.PROMPT):
        _pack_file_attachment(entry, flow_message, attachment_dir)
        return
    if entry.attachment_type != AttachmentType.TYPE_ID:
        return
    tid = TypeId(entry.data)
    entry_type, entry_id = tid.type, tid.id
    if not entry_type or not entry_id:
        return
    if entry_type == BuiltinEntityType.SPEC.value:
        await _pack_spec_attachment(entry_id, attachment_dir)
    elif entry_type == EntityType.PROMPT.value:
        await _pack_prompt_attachment(entry_id, attachment_dir)
    elif entry_type == BuiltinEntityType.TASK.value:
        await _pack_task_attachment(entry_id, attachment_dir)
    elif entry_type == BuiltinEntityType.CONVERSATION.value:
        await _pack_conversation_attachment(entry_id, flow_message, attachment_dir)
    elif entry_type == BuiltinEntityType.FLOW_MESSAGE.value:
        await _pack_flow_message_entry(entry_id, attachment_dir)
    elif entry_type == BuiltinEntityType.CLAUDE_SESSION.value:
        await _pack_claude_session_attachment(entry_id, attachment_dir)
    elif entry_type in _FS_ROOTED_TYPES:
        await _pack_fs_rooted_attachment(entry_type, entry_id, attachment_dir)


# ---------------------------------------------------------------------------
# FS-rooted asset packing (skill, agent, …).
#
# These entity types are *filesystem-primary*: the canonical record is the
# on-disk subtree under ``<root>/.claude/...``. Pack preserves that subtree
# verbatim; unpack restores it and lets the FSIndexer rediscover the entity.
# No type-specific serialization (header.json etc.) — the on-disk shape *is*
# the record format.
# ---------------------------------------------------------------------------

_FS_ROOTED_TYPES = frozenset({
    BuiltinEntityType.SKILL.value,
    BuiltinEntityType.AGENT.value,
    EntityType.WORKFLOW.value,
    EntityType.WHITEBOARD.value,
})

_CLAUDE_ANCHOR = ".claude"


async def _fs_rooted_asset_path(entry_type: str, entry_id: str) -> "Path | None":
    """Resolve the live ``.claude/…`` on-disk path for an FS-rooted asset.

    Skill/Agent take the O(1) FSRecord shadow lookup (a perf shortcut, not a
    capability difference — their entities also expose ``asset_ref``). Every
    other FS-rooted type (workflow ``.claude/workflows/<name>.md``, whiteboard
    ``.claude/whiteboards/<name>/``) resolves through the entity's ``asset_ref``
    (the live path string), so the dispatch stays generic. Returns None when
    the asset can't be located.
    """
    def _get_skill(eid: str):
        from flow_sdk.fs_store.operations.skill import get_skill
        return get_skill(eid)

    def _get_agent(eid: str):
        from flow_sdk.fs_store.operations.agent import get_agent
        return get_agent(eid)

    shadow_getter = {
        BuiltinEntityType.SKILL.value: _get_skill,
        BuiltinEntityType.AGENT.value: _get_agent,
    }.get(entry_type)
    if shadow_getter is not None:
        rec = shadow_getter(entry_id)
        ref = getattr(rec, "asset_ref", None) if rec else None
        return Path(ref._path) if ref is not None else None  # FSRecord.asset_ref is an FSRef

    # Generic: resolve the entity row and read its (string) live asset_ref.
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    cls = SchemaRegistry.get_entity_cls(entry_type)
    if cls is None:
        return None
    ent = await cls.get_one({"id": entry_id})
    ref = getattr(ent, "asset_ref", None) if ent else None
    return Path(ref) if isinstance(ref, str) and ref else None


def _claude_relative_path(asset_path: Path) -> Path:
    """Return the asset's path relative to the nearest ``.claude`` anchor.

    Example: ``/home/u/.claude/skills/foo/SKILL.md`` →
    ``Path(".claude/skills/foo/SKILL.md")``.

    Raises ``ValueError`` if ``.claude`` is not in the path — that's a real
    misconfiguration (skill/agent outside the canonical layout), not a
    silent-skip case.
    """
    parts = asset_path.parts
    for i, p in enumerate(parts):
        if p == _CLAUDE_ANCHOR:
            return Path(*parts[i:])
    raise ValueError(
        f"FS-rooted asset path missing '{_CLAUDE_ANCHOR}' anchor: {asset_path}"
    )


def _ensure_asset_dest_root(asset_dest_root: Path | None) -> Path:
    """Resolve the unpack destination for FS-rooted assets.

    Called lazily — only when an FS-rooted entry is actually encountered, so
    bundles without skill/agent attachments never allocate a temp dir.
    """
    if asset_dest_root is not None:
        return asset_dest_root
    chosen = Path(tempfile.mkdtemp(prefix="flowmsg_assets_"))
    logger.info("[bundle] asset_dest_root unset; restoring FS-rooted assets to %s", chosen)
    return chosen


def _restore_fs_rooted_entry(
    entry_dir: Path, asset_dest_root: Path, overwrite: bool,
) -> bool:
    """Copy ``attachment/<type>-@<id>/.claude/…`` into ``asset_dest_root/.claude/…``.

    Returns True when at least one file was restored. Raises
    ``FlowMessageExistsError`` on collision when ``overwrite=False``.
    """
    bundle_claude = entry_dir / _CLAUDE_ANCHOR
    if not bundle_claude.is_dir():
        return False
    conflicts: list[dict] = []
    copied_any = False
    for src in bundle_claude.rglob("*"):
        if not src.is_file():
            continue
        rel = src.relative_to(entry_dir)  # ".claude/skills/foo/SKILL.md"
        dest = asset_dest_root / rel
        if dest.exists() and not overwrite:
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


async def _reindex_asset_dest_root(asset_dest_root: Path) -> None:
    """Reindex a restored ``.claude/`` subtree (skill/agent FS-rooted assets)."""
    from flow_sdk.fs_store.record_types import RecordType

    await _reindex_root(asset_dest_root, RecordType.USER_HOME_FOLDER)


async def _reindex_project_root(root: Path) -> None:
    """Index ``root`` as a project-cwd container so a restored shared spec
    materializes (``extract_spec → Entity.from_record``, idempotent + body-aware
    — heals a content-less stub). Scoped to SPEC so the generic project walk
    doesn't also index the ``spec.md`` as a plain markdown duplicate. No
    synthetic ``user_home/specs`` path is fabricated.
    """
    from flow_sdk.fs_store.record_types import RecordType

    await _reindex_root(root, RecordType.REAL_PROJECT_CWD, types=(RecordType.SPEC,))


def _restore_spec_source(spec_file: Path, entry_id: str, staging_root: Path) -> None:
    """Restore a bundle ``spec.md`` into the staging folder's ``specs/`` dir.

    Destination: ``<staging>/specs/spec-@<id>/spec.md`` — the folder name is the
    bundle's own ``spec-@<id>`` (deterministic, never a derived/creative slug).
    The post-loop reindex (project-cwd) materializes the row from this real
    file. Entity identity comes from the frontmatter ``id``: copied verbatim
    when the bundle already carries it, otherwise the shared ``entry_id`` is
    injected (legacy bundles predating the id-in-frontmatter pack) so the SAME
    row materializes rather than a uuid5(path) duplicate.
    """
    dest = staging_root / "specs" / f"spec-@{entry_id}" / "spec.md"
    dest.parent.mkdir(parents=True, exist_ok=True)
    rewritten = _inject_id_into_frontmatter_text(spec_file.read_text(encoding="utf-8"), entry_id)
    if rewritten is None:
        shutil.copy2(spec_file, dest)  # bundle already carries the id → verbatim
    else:
        dest.write_text(rewritten, encoding="utf-8")




async def _pack_fs_rooted_attachment(
    entry_type: str, entry_id: str, attachment_dir: Path,
) -> None:
    """Copy the asset's on-disk subtree (file or folder) into the bundle.

    Bundle layout: ``attachment/<type>-@<id>/.claude/<relative-path>``. Format
    is unchanged from the source — the indexer reads exactly the same shape
    on disk in production, so unpack just needs to restore + reindex.
    """
    src = await _fs_rooted_asset_path(entry_type, entry_id)
    if src is None or not src.exists():
        return
    rel = _claude_relative_path(src)
    dest_root = attachment_dir / f"{entry_type}-@{entry_id}"
    dest = dest_root / rel
    dest.parent.mkdir(parents=True, exist_ok=True)
    if src.is_dir():
        shutil.copytree(src, dest, dirs_exist_ok=True)
        # Folder assets (whiteboard, skill) key their id off the main doc's
        # frontmatter id, falling back to a name/path-derived value that won't
        # match the sender's entity id. Pin the sender's id into the main doc so
        # the receiver's gen_id materializes the SAME entity. (The doc filename
        # is hardcoded rather than read from TypeInfo.main_file because the
        # server's runtime schema registry doesn't reliably carry main_file for
        # these types — the literal list is the proven path.)
        for main_doc in ("WHITE_BOARD.md", "SKILL.md"):
            doc = dest / main_doc
            if doc.exists():
                _ensure_id_in_md_frontmatter(doc, entry_id)
    else:
        shutil.copy2(src, dest)
        # A single-file asset (workflow) keys its id off the file PATH, which
        # differs on the receiver. Pin the sender's id into the packed doc's
        # frontmatter so the receiver's gen_id (which preserves an existing
        # frontmatter id) materializes the SAME entity instead of a uuid5(path)
        # duplicate — mirrors the spec id-in-frontmatter contract.
        _ensure_id_in_md_frontmatter(dest, entry_id)


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

async def _create_prompt_from_file(prompt_file: Path, prompt_id: str, owner_typeid) -> None:
    """Materialize a bundled ``prompt.md`` as a local library Prompt entity.

    Parsed with the indexer's own ``extract_prompt`` so frontmatter fidelity
    matches a normal rescan. The receiver-side Prompt lands at USER scope
    (``project_id=None`` → ``<user_home>/prompts/``): the conversation's
    project is unmapped at unpack time, and prompts aren't project-coupled
    for execution. The ``owns_main_ref`` save writes the backing .md and the
    record folder — which is what flips ``body_downloaded``.
    """
    from flow_sdk.builtin.prompt import Prompt
    from flow_sdk.fs_store.fs_ref import FSRef
    from flow_sdk.fs_store.indexer.functions.prompt import extract_prompt

    try:
        [rec] = extract_prompt(FSRef(prompt_file))
        prompt = Prompt.model_validate({
            "id": prompt_id,
            "name": rec.name or "Shared prompt",
            "text": rec.text or "",
            "icon": getattr(rec, "icon", None),
            "color": getattr(rec, "color", None),
            "use_count": getattr(rec, "use_count", 0) or 0,
            "last_used_at": getattr(rec, "last_used_at", None),
            "project_id": None,
        })
        await prompt.save(owner_typeid)
    except Exception as e:
        logger.warning("unpack_bundle: could not create Prompt from %s: %s", prompt_file, e)


async def unpack_bundle(
    zip_path: Path,
    local_user_id: str,
    *,
    overwrite: bool = False,
    asset_dest_root: Path | None = None,
) -> "FlowMessage":
    """Extract .flowmsg, materialize entities, return FlowMessage.

    Raises FlowMessageExistsError on conflict when overwrite=False.

    FS-rooted assets (skill, agent, …) are restored as a literal ``.claude/…``
    subtree under ``asset_dest_root``. When ``asset_dest_root`` is None, a
    fresh ``tempfile.mkdtemp()`` is used so production callers don't have to
    pick a real destination yet — restored assets are indexed but parked.
    Tests pass an explicit ``asset_dest_root`` so they can assert on the
    layout.
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
        # 1. Extract zip
        with zipfile.ZipFile(zip_path, "r") as zf:
            zf.extractall(tmp_root)

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
            BuiltinEntityType.CONVERSATION.value: 2,
            BuiltinEntityType.FLOW_MESSAGE.value: 3,
        }

        def _entry_sort_key(p: Path) -> int:
            t, _, _ = p.name.partition("-@")
            return _TYPE_ORDER.get(t, 99)

        conversation_id: str | None = None
        task_id: str = ""
        fs_rooted_restored = False
        indexable_restored = False
        # Staging destination for source-backed shared entities (spec, …): the
        # conversation's OWN data folder. Sources are restored there verbatim,
        # then indexed as a project-cwd root (`spec_project_fn` scans
        # `<root>/specs/…`). The message folder IS the home — no synthetic
        # `user_home/specs` path is fabricated.
        staging_conv_id = (msg_data.get("conversation_id") or "").strip() or next(
            (TypeId(c).id for c in (msg_data.get("shared_context_entities") or [])
             if TypeId(c).type == BuiltinEntityType.CONVERSATION.value),
            None,
        )
        staging_root: Path | None = None
        if staging_conv_id:
            from flow_sdk.fs_store.operations.conversation import default_jsonl_path  # noqa: PLC0415
            staging_root = default_jsonl_path(staging_conv_id).parent
            staging_root.mkdir(parents=True, exist_ok=True)
        if attachment_dir.exists():
            for entry_dir in sorted(attachment_dir.iterdir(), key=_entry_sort_key):
                if not entry_dir.is_dir():
                    continue
                name = entry_dir.name
                entry_type, _, entry_id = name.partition("-@")
                if not entry_type or not entry_id:
                    continue

                if entry_type in _FS_ROOTED_TYPES:
                    asset_dest_root = _ensure_asset_dest_root(asset_dest_root)
                    if _restore_fs_rooted_entry(entry_dir, asset_dest_root, overwrite):
                        fs_rooted_restored = True
                    continue

                if entry_type == EntityType.PROMPT.value:
                    prompt_file = entry_dir / "prompt.md"
                    if prompt_file.exists():
                        # Create-once, same contract as SPEC below: a re-unpack
                        # must not clobber receiver-side library edits.
                        from flow_sdk.builtin.prompt import Prompt  # noqa: PLC0415
                        if overwrite or await Prompt.get_one({"id": entry_id}) is None:
                            await _create_prompt_from_file(prompt_file, entry_id, owner_typeid)

                elif entry_type == BuiltinEntityType.SPEC.value:
                    spec_file = entry_dir / "spec.md"
                    if spec_file.exists() and staging_root is not None:
                        # Restore the spec source into the conversation folder's
                        # ``specs/`` dir, then let the post-loop reindex
                        # materialize the row (``extract_spec`` → ``from_record``)
                        # — idempotent + body-aware, no create-once skip. A
                        # pre-existing content-less stub is HEALED (its body
                        # lands), never blocked. User data is preserved verbatim
                        # when the bundle carries the id.
                        _restore_spec_source(spec_file, entry_id, staging_root)
                        indexable_restored = True

                elif entry_type == BuiltinEntityType.TASK.value:
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
                        sess_payload = {**sess_data, "id": sess_id, "remote": False}
                        existing_sess = await ClaudeSession.get_one({"id": sess_id})
                        if existing_sess is None or overwrite:
                            sess = ClaudeSession.model_validate(sess_payload)
                            await sess.save(owner_typeid)
                        elif _fill_merge_entity(existing_sess, sess_payload, ("id", "type")):
                            await existing_sess.save(owner_typeid)

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

        # 4b. Re-index restored FS-rooted assets so DB rows + FTS5 entries land
        # before any UI sync fires. Skipped when no FS-rooted entries were
        # present in the bundle (zero-cost for vanilla spec/task bundles).
        if fs_rooted_restored and asset_dest_root is not None:
            await _reindex_asset_dest_root(asset_dest_root)

        # 4c. Re-index source-backed shared entities (spec, …) restored into the
        # conversation's data folder. One project-cwd reindex materializes every
        # row from its real file — idempotent + body-aware, healing any
        # content-less stub. Skipped (zero-cost) when nothing was restored.
        if indexable_restored and staging_root is not None:
            await _reindex_project_root(staging_root)

        # 5. Resolve FILE attachment paths and materialize the top-level FlowMessage
        # via the unified write path. ``materialize_flow_message`` saves the
        # FM, appends a typed Pointer to conversation.jsonl, projects
        # message_ids/message_count, and dispatches WS sync (FM CREATE then
        # Conversation UPDATE) — same sequence every other producer uses.
        from flow_sdk.app.actions.materialize_flow_message import materialize_flow_message

        top_fm_id = msg_data.get("id") or FlowMessage.allocate_id(msg_data)
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
