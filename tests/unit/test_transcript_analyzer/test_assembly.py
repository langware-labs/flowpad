"""assemble_tree: nest separate sub-agent transcripts under their spawn.

Real Claude writes each sub-agent to ``<SID>/subagents/agent-<id>.jsonl`` + a
``.meta.json`` carrying ``toolUseId``. These tests drive that exact on-disk shape
(via ``_write_session``) and assert the join, depth reconstruction, deep cost
roll-up, orphan handling, and idempotency — without any live worker.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer import AgentTranscriptFile, EntryKind
from flow_sdk.transcript_analyzer.assembly import ROOT_LANE, assemble_tree
from flow_sdk.transcript_analyzer.entries import AgentSpawnEntry
from flow_sdk.transcript_analyzer.resolver import resolve_session_jsonl

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval

SID = "11111111-1111-4111-8111-111111111111"
MODEL = "claude-sonnet-4-5"


def _user(uuid: str, ts: str, text: str) -> dict:
    return {
        "type": "user", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def _spawn(uuid: str, ts: str, tuid: str, desc: str = "look") -> dict:
    return {
        "type": "assistant", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "message": {"id": f"m-{uuid}", "model": MODEL,
                    "content": [{"type": "tool_use", "id": tuid, "name": "Task",
                                 "input": {"subagent_type": "Explore",
                                           "description": desc, "prompt": "p"}}]},
    }


def _assistant_usage(uuid: str, ts: str, in_tok: int, out_tok: int) -> dict:
    """Assistant line carrying a usage block → priced UsageEntry(s)."""
    return {
        "type": "assistant", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "message": {"id": f"m-{uuid}", "model": MODEL,
                    "content": [{"type": "text", "text": "ok"}],
                    "usage": {"input_tokens": in_tok, "output_tokens": out_tok}},
    }


def _meta(tuid: str) -> dict:
    return {"agentType": "Explore", "description": "look", "toolUseId": tuid}


def _write_session(root: Path, lines: list[dict],
                   *, subagents: dict[str, tuple[dict, list[dict]]] | None = None) -> None:
    proj = root / "projects" / "-tmp-proj"
    proj.mkdir(parents=True)
    (proj / f"{SID}.jsonl").write_text(
        "\n".join(json.dumps(line) for line in lines) + "\n", encoding="utf-8")
    for agent_id, (meta, agent_lines) in (subagents or {}).items():
        sub = proj / SID / "subagents"
        sub.mkdir(parents=True, exist_ok=True)
        (sub / f"{agent_id}.meta.json").write_text(json.dumps(meta), encoding="utf-8")
        (sub / f"{agent_id}.jsonl").write_text(
            "\n".join(json.dumps(line) for line in agent_lines) + "\n", encoding="utf-8")


@pytest.fixture()
def claude_home(tmp_path, monkeypatch) -> Path:
    home = tmp_path / ".claude"
    monkeypatch.setattr(
        "flow_sdk.transcript_analyzer.resolver._claude_projects_dir",
        lambda: home / "projects",
    )
    return home


def _root(home: Path) -> AgentTranscriptFile:
    return AgentTranscriptFile("claude", resolve_session_jsonl("claude", SID), session_id=SID)


def _spawn_entries(t: AgentTranscriptFile) -> list[AgentSpawnEntry]:
    return [e for e in t.entries if isinstance(e, AgentSpawnEntry)]


# ── nesting ──────────────────────────────────────────────────────────────────

def test_subagent_entries_nested_under_spawn(claude_home):
    sub_lines = [_user("su1", "2026-06-12T10:01:00Z", "subtask")]
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={"agent-abc": (_meta("spawn1"), sub_lines)},
    )
    t = _root(claude_home)
    assert _spawn_entries(t)[0].children == []  # not nested until assembled

    tree = assemble_tree(t)
    spawn = _spawn_entries(t)[0]
    assert len(spawn.children) == 1
    assert spawn.children[0].kind is EntryKind.USER_MESSAGE
    assert [n.lane_id for n in tree.nodes] == ["agent-abc"]
    assert tree.nodes[0].parent_lane_id == ROOT_LANE
    assert tree.orphans == []


def test_depth_2_nesting_reconstructed_from_flat_dir(claude_home):
    # main spawns A (spawn1); A's transcript spawns B (spawn2). Both files live
    # flat in subagents/ — depth must be rebuilt from the toolUseId graph.
    a_lines = [_user("sa1", "2026-06-12T10:01:00Z", "A working"),
               _spawn("sa2", "2026-06-12T10:01:30Z", "spawn2", desc="deeper")]
    b_lines = [_user("sb1", "2026-06-12T10:02:00Z", "B working")]
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={
            "agent-A": (_meta("spawn1"), a_lines),
            "agent-B": (_meta("spawn2"), b_lines),
        },
    )
    t = _root(claude_home)
    tree = assemble_tree(t)

    # spawnA (in main) → A entries; the Task inside A → B entries (two levels).
    spawn_a = _spawn_entries(t)[0]
    nested_spawns = [c for c in spawn_a.children if isinstance(c, AgentSpawnEntry)]
    assert len(nested_spawns) == 1
    assert len(nested_spawns[0].children) == 1
    assert nested_spawns[0].children[0].kind is EntryKind.USER_MESSAGE

    by_lane = tree.by_lane
    assert by_lane["agent-A"].parent_lane_id == ROOT_LANE
    assert by_lane["agent-B"].parent_lane_id == "agent-A"  # nested, not flat under root


# ── cost ─────────────────────────────────────────────────────────────────────

def test_deep_cost_includes_subagents_without_double_count(claude_home):
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _assistant_usage("a0", "2026-06-12T10:00:05Z", 1000, 100),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={
            "agent-A": (_meta("spawn1"),
                        [_assistant_usage("sa0", "2026-06-12T10:01:00Z", 2000, 200)]),
        },
    )
    t = _root(claude_home)
    root_only = t.cost()  # shallow — this file's own usage

    assemble_tree(t)
    # cost() stays shallow (per-file); cost_deep() rolls in stitched sub-agents.
    assert t.cost() == pytest.approx(root_only)

    child = AgentTranscriptFile(
        "claude",
        resolve_session_jsonl("claude", SID).parent / SID / "subagents" / "agent-A.jsonl",
    )
    assert root_only > 0 and child.cost() > 0
    assert t.cost_deep() == pytest.approx(root_only + child.cost())


# ── orphans / idempotency / flat ────────────────────────────────────────────

def test_orphan_subagent_is_surfaced_not_dropped(claude_home):
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={"agent-ghost": (_meta("no-such-tuid"),
                                   [_user("g1", "2026-06-12T10:01:00Z", "orphaned")])},
    )
    t = _root(claude_home)
    tree = assemble_tree(t)
    assert [n.lane_id for n in tree.orphans] == ["agent-ghost"]
    assert tree.nodes == []
    assert _spawn_entries(t)[0].children == []  # spawn1 had no matching file


def test_assemble_is_idempotent(claude_home):
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={"agent-abc": (_meta("spawn1"),
                                 [_user("su1", "2026-06-12T10:01:00Z", "subtask")])},
    )
    t = _root(claude_home)
    assemble_tree(t)
    first = len(_spawn_entries(t)[0].children)
    assemble_tree(t)
    assert len(_spawn_entries(t)[0].children) == first == 1


def test_flat_transcript_unaffected(claude_home):
    _write_session(claude_home, [
        _user("u1", "2026-06-12T10:00:00Z", "go"),
        _assistant_usage("a0", "2026-06-12T10:00:05Z", 1000, 100),
    ])
    t = _root(claude_home)
    before = list(t.entries)
    tree = assemble_tree(t)
    assert tree.nodes == [] and tree.orphans == []
    assert t.entries == before
    assert list(t.walk()) == before  # walk == flat iteration with no children


def test_to_dict_serializes_children_recursively(claude_home):
    _write_session(
        claude_home,
        [_user("u1", "2026-06-12T10:00:00Z", "go"),
         _spawn("a1", "2026-06-12T10:00:30Z", "spawn1")],
        subagents={"agent-abc": (_meta("spawn1"),
                                 [_user("su1", "2026-06-12T10:01:00Z", "subtask")])},
    )
    t = _root(claude_home)
    assemble_tree(t)
    d = _spawn_entries(t)[0].to_dict()
    assert d["kind"] == "agent_spawn"
    assert len(d["children"]) == 1
    assert d["children"][0]["kind"] == "user_message"
