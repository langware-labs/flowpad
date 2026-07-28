"""Walker for *installed* worker transcripts — the receive-side counterpart to
``claude_sessions_fn`` / ``codex_sessions_fn`` / ``copilot_sessions_fn``.

A transcript that arrives as an attachment is an ordinary file-backed asset, so
it installs to the placement layer's destination for its type:

    <scope root>/<harness prefix>/transcripts/<id>.jsonl

That is nowhere near the harness's own session store (``~/.claude/projects/…``,
``~/.codex/sessions/…``, ``~/.copilot/session-state/…``), which is all the
per-worker walkers glob — so without this walker an installed transcript sits on
disk with no row behind it, and every surface that resolves it (the attachment
chip, the project session list) has nothing to bind to.

Worker-generic by construction: this module is the single owner of "the
transcripts family installs here", and asks the registry — generically — which
types declare that family and what subdir each one's harness puts them in. A new
worker enrolls by declaring ``family=TRANSCRIPTS_FAMILY`` on its
``TypeMetadata`` — no edit here.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING

from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.indexer.index_function import IndexerOptions
from flow_sdk.fs_store.placement import TRANSCRIPTS_FAMILY
from flow_sdk.fs_store.record_types import RecordType

if TYPE_CHECKING:
    from flow_sdk.fs_store.schema_registry import TypeInfo


def transcript_subdir_to_info() -> "dict[str, TypeInfo]":
    """Install subdir → ``TypeInfo`` for every worker-session type.

    ``.claude/transcripts`` → claude_session, ``.agents/transcripts`` →
    codex_session, ``.github/transcripts`` → copilot_session. The transcripts
    vocabulary lives here rather than in the registry, which stays domain-free.
    """
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    return SchemaRegistry.main_subdir_to_info(TRANSCRIPTS_FAMILY)


def installed_transcript_output_types() -> frozenset[RecordType]:
    """The record types this walker can emit — the ``output_type`` annotation
    that keeps typed scans (``?type=skill``) able to prune it."""
    return frozenset(RecordType(info.type_name) for info in transcript_subdir_to_info().values())


def installed_transcripts_fn(
    nodes: list[FSRef],
    opts: IndexerOptions,
) -> list[FSRef]:
    subdirs = transcript_subdir_to_info()
    out: list[FSRef] = []
    for node in nodes:
        for subdir, info in subdirs.items():
            transcripts_dir = Path(node.path) / subdir
            if not transcripts_dir.is_dir():
                continue
            for jsonl in sorted(transcripts_dir.glob("*.jsonl")):
                out.append(
                    FSRef(
                        jsonl,
                        record_type=RecordType(info.type_name),
                        parent=node,
                    )
                )
    return out
