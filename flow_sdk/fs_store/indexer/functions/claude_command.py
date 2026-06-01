"""Indexer function: <root> -> COMMAND.

Emits COMMAND for every `*.md` in `<root>/.claude/commands/`. Legacy walker
only searches user (~/.claude/commands) and cwd (<cwd>/.claude/commands),
so register only on USER_HOME_FOLDER and CWD_ROOT. Scope inherits via FSRef.

Also provides the extractor + id mint used by FSIndexer in place of the
deleted ``ClaudeCommandFsRecord`` subclass. Registration lives in
``flow_sdk/fs_store/indexer/builtin.py``.
"""

from __future__ import annotations

from pathlib import Path

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.record_types import RecordType


def command_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    out: list[FSRef] = []
    seen: set[str] = set()
    for node in nodes:
        commands = Path(node.path) / ".claude" / "commands"
        if not commands.is_dir():
            continue
        for md in sorted(commands.glob("*.md")):
            if not md.is_file():
                continue
            key = str(md.resolve())
            if key in seen:
                continue
            seen.add(key)
            out.append(
                FSRef(md, record_type=RecordType.COMMAND, parent=node)
            )
    return out


def command_id(ref: FSRef) -> str:
    """Deterministic id: ``<scope>:<command_name>``.

    Scope comes from the FSRef parent-chain stamping; command_name is the
    .md filename stem. Same formula the deleted ``ClaudeCommandFsRecord``
    used in both ``__init__`` and ``getId``.
    """
    scope = ref.scope or "user"
    return f"{scope}:{ref._path.stem}"


def extract_claude_command(ref: FSRef) -> list[FSRecord]:
    """Parse a single ``.md`` command file into a Record.

    Replaces ``ClaudeCommandFsRecord._from_fsref_sync``. The record is a base
    ``Record`` instance — no subclass needed. Returns an empty list if the
    file can't be read.
    """
    md_file = ref._path
    try:
        content = md_file.read_text(encoding="utf-8")
    except OSError:
        return []
    scope = ref.scope or "user"
    command_name = md_file.stem
    rec = FSRecord(
        type=RecordType.COMMAND,
        id=f"{scope}:{command_name}",
        name=command_name,
        command_name=command_name,
        content=content,
        scope=scope,
    )
    rec.source_file = str(md_file)
    object.__setattr__(rec, "_asset_ref", FSRef(md_file))
    return [rec]
