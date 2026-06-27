"""Compose a transcript with its sub-agent transcripts into one tree.

Real Claude Code writes each spawned sub-agent's transcript to a SEPARATE file
``<projects>/<SID>/subagents/agent-<agentId>.jsonl`` with a sibling
``agent-<agentId>.meta.json`` = ``{"agentType","description","toolUseId"}``. The
main JSONL holds only the ``Task`` tool_use + its tool_result — no inline
sidechain lines.

:func:`assemble_tree` parses each sub-agent file once, then stitches every
sub-agent's entries onto the :class:`AgentSpawnEntry.children` of the spawn whose
``tool_use_id`` matches the sub-agent's ``meta.toolUseId``. Matching is global
across all parsed files, so a sub-agent spawned from *inside* another sub-agent
nests to true depth — the flat on-disk dir is rebuilt into a tree purely from the
toolUseId graph.

This is a STATIC, finalized-doc step. It is deliberately NOT wired into the
streaming reader (:meth:`AgentTranscriptFile.parse_delta`): a spawn line is
emitted long before its sub-agent finishes and each child file grows on its own
byte offset, so live nesting can't be expressed as a parent-file delta.
"""

from __future__ import annotations

import json
import logging
from dataclasses import dataclass, field
from pathlib import Path

from .entries import AgentSpawnEntry
from .transcript import AgentTranscriptFile

logger = logging.getLogger(__name__)

ROOT_LANE = "root"


def discover_subagent_files(jsonl_path: Path, session_id: str) -> list[tuple[Path, dict]]:
    """``(agent jsonl, parsed meta)`` pairs under ``<dir>/<sid>/subagents/``.

    Keyed off the ``agent-*.meta.json`` sidecars Claude writes next to each
    sub-agent transcript; the ``.jsonl`` is derived by name. Missing/un-parseable
    meta degrades to ``{}`` rather than dropping the file.
    """
    sub_dir = jsonl_path.parent / session_id / "subagents"
    if not sub_dir.is_dir():
        return []
    out: list[tuple[Path, dict]] = []
    for meta_path in sorted(sub_dir.glob("agent-*.meta.json")):
        jsonl = meta_path.with_name(meta_path.name.replace(".meta.json", ".jsonl"))
        if not jsonl.is_file():
            continue
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, ValueError):
            meta = {}
        out.append((jsonl, meta if isinstance(meta, dict) else {}))
    return out


@dataclass
class SubAgentNode:
    """One discovered sub-agent file, placed in the assembled tree."""

    lane_id: str                       # "agent-<id>" (file stem)
    transcript: AgentTranscriptFile
    meta: dict
    parent_lane_id: str                # owning lane: "root" or another "agent-<id>"

    @property
    def spawn_tool_use_id(self) -> str:
        return str(self.meta.get("toolUseId") or "")


@dataclass
class AssembledTree:
    """Result of :func:`assemble_tree`.

    ``root`` is the same object passed in — its ``AgentSpawnEntry`` children are
    now stitched. ``nodes`` are the placed sub-agents (each with its true
    ``parent_lane_id``); ``orphans`` are sub-agent files whose ``toolUseId``
    matched no spawn anywhere (surfaced, never silently dropped).
    """

    root: AgentTranscriptFile
    nodes: list[SubAgentNode] = field(default_factory=list)
    orphans: list[SubAgentNode] = field(default_factory=list)

    @property
    def by_lane(self) -> dict[str, SubAgentNode]:
        return {n.lane_id: n for n in self.nodes}


def assemble_tree(
    root: AgentTranscriptFile,
    *,
    session_id: str | None = None,
) -> AssembledTree:
    """Parse the sub-agent files of ``root`` and nest them under their spawns.

    Idempotent: re-running re-parses the child files and *replaces* each spawn's
    ``children`` (never appends), so calling twice yields the same tree.
    """
    sid = session_id or root.session_id

    # Parse each child file once. Index children by the spawn tool_use_id that
    # owns them (from meta) so stitching is a dict lookup.
    discovered: list[tuple[str, AgentTranscriptFile, dict]] = []
    children_by_tuid: dict[str, AgentTranscriptFile] = {}
    for jsonl, meta in discover_subagent_files(root.path, sid):
        sub = AgentTranscriptFile(root.worker_type, jsonl)
        lane_id = jsonl.stem  # agent-<id>
        discovered.append((lane_id, sub, meta))
        tuid = str(meta.get("toolUseId") or "")
        if tuid:
            children_by_tuid[tuid] = sub

    # Which lane (file) CONTAINS the spawn for a given tool_use_id. The main
    # file's spawns are owned by "root"; a child file's spawns are owned by that
    # child's lane — this is how depth is reconstructed from the flat dir.
    owner_of_tuid: dict[str, str] = {}

    def _index_spawns(entries: list, lane: str) -> None:
        for e in entries:
            if isinstance(e, AgentSpawnEntry) and e.tool_use_id:
                owner_of_tuid[e.tool_use_id] = lane

    _index_spawns(root.entries, ROOT_LANE)
    for lane_id, sub, _meta in discovered:
        _index_spawns(sub.entries, lane_id)

    # Stitch every spawn (across all files) to its child subtree by tool_use_id.
    # Assign (not extend) so repeated assembly stays idempotent.
    def _stitch(entries: list) -> None:
        for e in entries:
            if isinstance(e, AgentSpawnEntry):
                child = children_by_tuid.get(e.tool_use_id)
                e.children = child.entries if child is not None else []

    _stitch(root.entries)
    for lane_id, sub, _meta in discovered:
        _stitch(sub.entries)

    # Place each sub-agent under its owning lane; orphan if no spawn anywhere
    # references it.
    nodes: list[SubAgentNode] = []
    orphans: list[SubAgentNode] = []
    for lane_id, sub, meta in discovered:
        tuid = str(meta.get("toolUseId") or "")
        parent = owner_of_tuid.get(tuid)
        node = SubAgentNode(
            lane_id=lane_id, transcript=sub, meta=meta,
            parent_lane_id=parent or ROOT_LANE,
        )
        (nodes if parent is not None else orphans).append(node)

    if orphans:
        logger.debug(
            "assemble_tree: %d orphan sub-agent file(s) with no matching spawn in %s",
            len(orphans), root.path,
        )
    return AssembledTree(root=root, nodes=nodes, orphans=orphans)
