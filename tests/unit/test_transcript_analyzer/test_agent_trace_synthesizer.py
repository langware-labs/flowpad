"""AgentTrace synthesizer: skeleton structure, lanes from subagent files,
deterministic markers, and annotation merge. Pure parsing — no live workers."""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.transcript_analyzer.synthesizers.agent_trace import (
    STUCK_REPEAT_THRESHOLD,
    merge_annotations,
    synthesize_agent_trace,
)

pytestmark = pytest.mark.timeout(5)

SID = "11111111-1111-4111-8111-111111111111"


def _user(uuid: str, ts: str, text: str) -> dict:
    return {
        "type": "user", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "message": {"role": "user", "content": [{"type": "text", "text": text}]},
    }


def _tool_use(uuid: str, ts: str, tuid: str, name: str, tool_input: dict) -> dict:
    return {
        "type": "assistant", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "message": {"id": f"m-{uuid}", "model": "claude",
                    "content": [{"type": "tool_use", "id": tuid, "name": name,
                                 "input": tool_input}]},
    }


def _tool_result(uuid: str, ts: str, tuid: str, output: str, *, is_error: bool = False) -> dict:
    # Real Claude failure lines carry both the block-level is_error AND
    # toolUseResult.exitCode (what survives shell-result folding).
    tur: dict = {"stderr": output, "exitCode": 1} if is_error else {"stdout": output}
    return {
        "type": "user", "uuid": uuid, "sessionId": SID, "timestamp": ts,
        "toolUseResult": tur,
        "message": {"role": "user", "content": [
            {"type": "tool_result", "tool_use_id": tuid, "content": output,
             "is_error": is_error},
        ]},
    }


def _write_session(root: Path, lines: list[dict], *, subagents: dict[str, tuple[dict, list[dict]]] | None = None) -> None:
    """Lay out ~/.claude/projects/<proj>/<SID>.jsonl (+ subagents) under root."""
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


def test_segments_cut_at_prompts_and_calls_collected(claude_home):
    _write_session(claude_home, [
        _user("u1", "2026-06-12T10:00:00Z", "first goal"),
        _tool_use("a1", "2026-06-12T10:00:10Z", "tu1", "Bash",
                  {"command": "echo hi"}),
        _tool_result("r1", "2026-06-12T10:00:11Z", "tu1", "hi"),
        _user("u2", "2026-06-12T10:05:00Z", "second goal"),
        _tool_use("a2", "2026-06-12T10:05:10Z", "tu2", "Read",
                  {"file_path": "/tmp/x"}),
    ])
    trace = synthesize_agent_trace(SID)

    assert trace["version"] == 1
    assert trace["session_id"] == SID
    assert trace["summary"]["lane_count"] == 1
    root = trace["lanes"][0]
    assert root["kind"] == "root"
    assert [s["label"] for s in root["segments"]] == ["first goal", "second goal"]
    assert trace["summary"]["tool_call_count"] == 2
    prompts = [e for e in trace["events"] if e["kind"] == "user_prompt"]
    assert [p["label"] for p in prompts] == ["first goal", "second goal"]
    assert trace["annotations"] == {"goals": [], "divergences": [], "verdict": None, "notes": []}


def test_subagent_files_become_lanes_joined_on_tool_use_id(claude_home):
    sub_lines = [
        _user("su1", "2026-06-12T10:01:00Z", "subtask"),
        _tool_use("sa1", "2026-06-12T10:01:10Z", "stu1", "Bash", {"command": "ls"}),
    ]
    _write_session(
        claude_home,
        [
            _user("u1", "2026-06-12T10:00:00Z", "go"),
            _tool_use("a1", "2026-06-12T10:00:30Z", "spawn1", "Task",
                      {"subagent_type": "Explore", "description": "look around",
                       "prompt": "look"}),
        ],
        subagents={"agent-abc123": ({"agentType": "Explore",
                                     "description": "look around",
                                     "toolUseId": "spawn1"}, sub_lines)},
    )
    trace = synthesize_agent_trace(SID)

    assert trace["summary"]["lane_count"] == 2
    sub = next(lane for lane in trace["lanes"] if lane["kind"] == "subagent")
    assert sub["id"] == "agent-abc123"
    assert sub["agent_type"] == "Explore"
    assert sub["spawn_tool_use_id"] == "spawn1"
    assert sub["parent_lane_id"] == "root"
    assert len(sub["segments"]) == 1
    spawns = [e for e in trace["events"] if e["kind"] == "agent_spawn"]
    assert len(spawns) == 1 and spawns[0]["label"] == "look around"


def test_failures_and_stuck_loop_marked(claude_home):
    lines = [_user("u1", "2026-06-12T10:00:00Z", "build it")]
    for i in range(STUCK_REPEAT_THRESHOLD):
        tuid = f"tu{i}"
        lines.append(_tool_use(f"a{i}", f"2026-06-12T10:00:{10 + i:02d}Z", tuid,
                               "Bash", {"command": "make build"}))
        lines.append(_tool_result(f"r{i}", f"2026-06-12T10:00:{11 + i:02d}Z", tuid,
                                  "error: nope", is_error=True))
    _write_session(claude_home, lines)
    trace = synthesize_agent_trace(SID)

    issues = [m for m in trace["markers"] if m["kind"] == "issue"]
    stucks = [m for m in trace["markers"] if m["kind"] == "stuck"]
    assert len(issues) == STUCK_REPEAT_THRESHOLD
    assert len(stucks) == 1
    assert "make build" in stucks[0]["detail"]
    assert all(m["source"] == "synthesizer" for m in trace["markers"])
    assert trace["summary"]["issue_count"] == STUCK_REPEAT_THRESHOLD + 1
    assert trace["lanes"][0]["segments"][0]["severity"] == "attention"


def test_skill_load_and_fail_events(claude_home):
    _write_session(claude_home, [
        _user("u1", "2026-06-12T10:00:00Z", "use skills"),
        _tool_use("a1", "2026-06-12T10:00:10Z", "tu1", "Skill", {"skill": "good-skill"}),
        _tool_result("r1", "2026-06-12T10:00:11Z", "tu1", "loaded"),
        _tool_use("a2", "2026-06-12T10:00:20Z", "tu2", "Skill", {"skill": "bad-skill"}),
        _tool_result("r2", "2026-06-12T10:00:21Z", "tu2", "no such skill", is_error=True),
    ])
    trace = synthesize_agent_trace(SID)

    by_kind = {}
    for e in trace["events"]:
        by_kind.setdefault(e["kind"], []).append(e)
    assert [e["label"] for e in by_kind["skill_load"]] == ["good-skill"]
    assert [e["label"] for e in by_kind["skill_fail"]] == ["bad-skill"]
    assert by_kind["skill_fail"][0]["severity"] == "attention"


def test_merge_annotations_recounts_and_appends_skill_markers(claude_home):
    _write_session(claude_home, [
        _user("u1", "2026-06-12T10:00:00Z", "goal"),
        _tool_use("a1", "2026-06-12T10:00:10Z", "tu1", "Bash", {"command": "true"}),
    ])
    skeleton = synthesize_agent_trace(SID)
    annotations = {
        "verdict": "mixed",
        "verdict_reason": "did the thing but diverged once",
        "goals": [{"label": "goal", "lane_id": "root",
                   "start_ts": "2026-06-12T10:00:00Z", "verdict": "ok"}],
        "divergences": [{"ts": "2026-06-12T10:00:10Z", "label": "went sideways"}],
        "issues": [{"ts": "2026-06-12T10:00:10Z", "label": "claimed success falsely",
                    "severity": "attention"}],
        "notes": ["skill x: instruction y unclear"],
    }
    trace = merge_annotations(skeleton, annotations)

    assert trace["summary"]["verdict"] == "mixed"
    assert trace["summary"]["divergence_count"] == 1
    assert trace["summary"]["issue_count"] == 1
    skill_markers = [m for m in trace["markers"] if m["source"] == "skill"]
    assert {m["kind"] for m in skill_markers} == {"divergence", "issue"}
    assert trace["annotations"]["notes"] == ["skill x: instruction y unclear"]
    # The skeleton is not mutated.
    assert skeleton["summary"]["verdict"] is None
