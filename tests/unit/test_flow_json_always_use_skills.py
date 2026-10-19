"""``flow.json``'s ``alwaysUseSkills`` — the difference between a skill being
OFFERED and being APPLIED.

A project's skills are otherwise only listed to the worker (name + description)
and the model decides whether to invoke one. Measured on a freshly cloned
help-desk project: a prompt that did not name the skill produced ZERO ``Skill``
invocations and an answer that merely *looked* like the skill's schema — the
description alone is enough to fake the shape, which is exactly how this hides.

So a project author who shares a help desk over git has no way to say "this
skill applies to every turn" — telling each recipient to type `use triage-ticket`
does not survive being shared. This declaration is that way, and it lives in
``flow.json`` because that file is the thing that travels with the repo.

The reader is the security boundary: the file comes from a third-party repo, so
every malformed or hostile shape must degrade to "declares nothing" rather than
raise into a launch (a declaration is a claim, never a capability). The strict
parser names what is wrong; the launch-path reader swallows it.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from flow_sdk.assets import flow_json
from flow_sdk.assets.flow_json import read_always_use_skills
from flow_sdk.schema.data_spec.flow_json_spec import MAX_ALWAYS_USE_SKILLS


def _declare(tmp_path: Path, body: str) -> Path:
    (tmp_path / "flow.json").write_text(body, encoding="utf-8")
    return tmp_path


def test_declared_skills_are_read_in_order(tmp_path):
    root = _declare(tmp_path, json.dumps({"alwaysUseSkills": ["triage-ticket", "ground-answer"]}))
    assert read_always_use_skills(root) == ("triage-ticket", "ground-answer")


def test_a_project_that_declares_nothing_opts_nothing_in(tmp_path):
    """The default has to be "offered", or every project silently forces every
    skill onto every turn — the opposite failure, and a costlier one."""
    root = _declare(tmp_path, json.dumps({"autolaunchJourney": "onboarding"}))
    assert read_always_use_skills(root) == ()


def test_no_file_at_all_declares_nothing(tmp_path):
    assert read_always_use_skills(tmp_path) == ()
    assert read_always_use_skills(None) == ()


@pytest.mark.parametrize(
    "body",
    [
        # A string is iterable: a missing ``isinstance(list)`` guard would turn
        # ``"triage-ticket"`` into thirteen one-character skill names.
        json.dumps({"alwaysUseSkills": "triage-ticket"}),
        json.dumps({"alwaysUseSkills": [1, None, {"n": "x"}, "real-skill"]}),
        # Bounded so one file cannot bloat every system prompt in the project.
        json.dumps({"alwaysUseSkills": [f"s{i}" for i in range(50)]}),
        "{not json",
        "[]",
    ],
    ids=["bare-string", "non-strings", "over-the-cap", "malformed", "non-object"],
)
def test_a_hostile_or_broken_file_declares_nothing_and_says_why(tmp_path, body):
    root = _declare(tmp_path, body)
    assert read_always_use_skills(root) == ()
    with pytest.raises(flow_json.FlowJsonError):
        flow_json.read_strict(root)


def test_repeats_collapse(tmp_path):
    root = _declare(tmp_path, json.dumps({"alwaysUseSkills": ["a", "a", " a ", "b"]}))
    assert read_always_use_skills(root) == ("a", "b")


def test_the_cap_is_inclusive(tmp_path):
    names = [f"s{i}" for i in range(MAX_ALWAYS_USE_SKILLS)]
    root = _declare(tmp_path, json.dumps({"alwaysUseSkills": names}))
    assert read_always_use_skills(root) == tuple(names)


def test_declaring_only_skills_is_a_whole_file(tmp_path):
    """A file whose ONLY declaration is this one must not read as empty, and
    round-trips as written."""
    root = _declare(tmp_path, json.dumps({"alwaysUseSkills": ["triage-ticket"]}))
    spec = flow_json.read_strict(root)
    assert spec.to_document() == {"alwaysUseSkills": ["triage-ticket"]}


def test_the_block_reaches_the_worker_prompt_and_nothing_else_does(tmp_path):
    """The launch-path reader: a declared skill becomes an instruction; a broken
    file yields no block instead of failing the launch."""
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess

    _declare(tmp_path, json.dumps({"alwaysUseSkills": ["triage-ticket", "ground-answer"]}))
    block = AgenticProcess(workdir=str(tmp_path), pty_mode=False)._read_always_use_skills_block()
    assert "`triage-ticket`, `ground-answer`" in block
    assert "without being asked" in block

    _declare(tmp_path, "{not json")
    assert AgenticProcess(workdir=str(tmp_path), pty_mode=False)._read_always_use_skills_block() == ""
    assert AgenticProcess(workdir="", pty_mode=False)._read_always_use_skills_block() == ""
