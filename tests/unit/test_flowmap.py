"""flowmap: a skill's map is checked before it is shown, and a run is laid on it frame by frame with the time
and cost of each frame — from the transcript alone (skills/flowmap/scripts)."""

from __future__ import annotations

import importlib.util
import json
import sys

import pytest

from flow_sdk.config import flowpad_assistant_project_root

pytestmark = pytest.mark.timeout(10)  # do not increase timeout without approval

SKILLS = flowpad_assistant_project_root() / ".claude" / "skills"


def _load(name: str):
    path = SKILLS / "flowmap" / "scripts" / f"{name}.py"
    spec = importlib.util.spec_from_file_location(f"flowmap_{name}", path)
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


map_check = _load("map_check")
trace_mod = _load("trace")

MAP = {
    "spec_kind": "flowmap.map", "skill": "demo", "line": "A demo.", "source_hash": "",
    "entries": [{"id": "e", "name": "Go", "say": ["mock this"], "gives": "a thing"}],
    "steps": [{"id": "a", "title": "Build", "type": "code", "takes": "x", "gives": "y", "source": "a.py", "match": ["a.py"]},
              {"id": "b", "title": "Check", "type": "code", "takes": "y", "gives": "ok", "source": "b.py", "match": ["b.py"]}],
    "links": [{"from": "e", "to": "a"}, {"from": "a", "to": "b"}, {"from": "b", "to": "a", "label": "fails", "loop": True},
              {"from": "b", "to": "o"}],
    "outcomes": [{"id": "o", "title": "Done"}],
}


def test_the_shipped_maps_are_sound():
    for skill in ("mockify",):
        m = json.loads((SKILLS / skill / "flowmap" / "map.value.json").read_text())
        assert map_check.problems(m) == [], skill


def test_a_broken_map_is_refused_by_name():
    m = json.loads(json.dumps(MAP))
    m["links"].append({"from": "a", "to": "nowhere"})
    m["links"][2].pop("loop")                       # b → a without loop: a cycle
    m["steps"].append({"id": "c", "title": "Lost", "type": "robot", "takes": "", "gives": "", "source": ""})
    bad = "\n".join(map_check.problems(m))
    for expect in ("to 'nowhere'", "a cycle", "c: no entry leads to it", "type 'robot'"):
        assert expect in bad, (expect, bad)


def test_the_map_goes_stale_when_the_skill_changes(tmp_path):
    (tmp_path / "SKILL.md").write_text("one")
    (tmp_path / "flowmap").mkdir()
    (tmp_path / "flowmap" / "map.value.json").write_text(json.dumps(MAP))
    before = map_check.source_hash(tmp_path)
    (tmp_path / "flowmap" / "map.value.json").write_text(json.dumps({**MAP, "line": "edited"}))
    assert map_check.source_hash(tmp_path) == before          # the map itself is not part of the skill
    (tmp_path / "SKILL.md").write_text("two")
    assert map_check.source_hash(tmp_path) != before


def _line(kind: str, ts: str, content, usage: dict | None = None, n: list = [0]) -> str:  # noqa: B006
    n[0] += 1
    msg = {"role": kind, "content": content}
    if kind == "assistant":
        msg |= {"id": f"msg{n[0]}", "model": "claude-sonnet-4-5", "usage": usage or {"input_tokens": 1000, "output_tokens": 100}}
    return json.dumps({"type": kind, "uuid": f"u{n[0]}", "sessionId": "s1", "timestamp": f"2026-11-15T10:00:{ts}Z", "message": msg})


def _bash(ts: str, command: str) -> str:
    return _line("assistant", ts, [{"type": "tool_use", "id": f"t{ts}", "name": "Bash", "input": {"command": command}}])


def test_a_run_is_laid_on_the_map_frame_by_frame(tmp_path, monkeypatch):
    skill = tmp_path / "demo"
    (skill / "flowmap").mkdir(parents=True)
    (skill / "flowmap" / "map.value.json").write_text(json.dumps(MAP))
    jsonl = tmp_path / "s1.jsonl"
    jsonl.write_text("\n".join([
        _line("user", "00", "please mock this flow"),
        _line("assistant", "01", [{"type": "tool_use", "id": "sk", "name": "Skill", "input": {"skill": "demo"}}]),
        _bash("10", "python3 a.py"),
        _bash("20", "cat b.py"),                       # reading a script is not running it
        _bash("30", "python3 b.py"),
        _bash("40", "python3 a.py && python3 b.py"),   # one command, two steps, in order
        _line("user", "59", "thanks"),                 # the person speaks again: the run ends
    ]) + "\n")
    monkeypatch.setattr(trace_mod, "resolve_session_jsonl", lambda worker, session: jsonl)

    run = trace_mod.trace("s1", skill)

    assert [f["node"] for f in run["frames"]] == ["e", "a", "b", "a", "b", "o"]
    assert [f["seconds"] for f in run["frames"]] == [0.0, 29.0, 10.0, 0.0, 19.0, 0.0]
    assert run["seconds"] == 58.0 and run["said"] == "please mock this flow"
    assert all(f["cost"] > 0 for f in run["frames"][1:3]) and run["cost"] == pytest.approx(sum(f["cost"] for f in run["frames"]))
    assert run["map"]["skill"] == "demo" and run["spec_kind"] == "flowmap.run"
