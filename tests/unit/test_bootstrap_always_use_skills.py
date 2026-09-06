"""``.flowpad/bootstrap.json``'s ``always_use_skills`` — the difference between a
skill being OFFERED and being APPLIED.

A project's skills are otherwise only listed to the worker (name + description)
and the model decides whether to invoke one. Measured on a freshly cloned
help-desk project: a prompt that did not name the skill produced ZERO ``Skill``
invocations and an answer that merely *looked* like the skill's schema — the
description alone is enough to fake the shape, which is exactly how this hides.

So a project author who shares a help desk over git has no way to say "this
skill applies to every turn" — telling each recipient to type `use triage-ticket`
does not survive being shared. This declaration is that way, and it lives in the
manifest because the manifest is the thing that travels with the repo.

The parser is the security boundary: the file comes from a third-party repo, so
every malformed or hostile shape must degrade to "declares nothing" rather than
raise (a manifest is a claim, never a capability).
"""

from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.builtin.bootstrap_manifest import (
    MAX_ALWAYS_USE_SKILLS,
    read_bootstrap_manifest,
)


def _manifest(tmp_path: Path, body: str) -> Path:
    (tmp_path / ".flowpad").mkdir(parents=True, exist_ok=True)
    (tmp_path / ".flowpad" / "bootstrap.json").write_text(body, encoding="utf-8")
    return tmp_path


def test_declared_skills_are_read_in_order(tmp_path):
    root = _manifest(tmp_path, json.dumps({"always_use_skills": ["triage-ticket", "ground-answer"]}))
    assert read_bootstrap_manifest(root).always_use_skills == ("triage-ticket", "ground-answer")


def test_a_project_that_declares_nothing_opts_nothing_in(tmp_path):
    """The default has to be "offered", or every project silently forces every
    skill onto every turn — the opposite failure, and a costlier one."""
    root = _manifest(tmp_path, json.dumps({"autolaunch_journey": "onboarding"}))
    assert read_bootstrap_manifest(root).always_use_skills == ()


def test_no_manifest_at_all_declares_nothing(tmp_path):
    assert read_bootstrap_manifest(tmp_path).always_use_skills == ()


def test_a_bare_string_is_rejected_not_walked_character_by_character(tmp_path):
    """A string is iterable, so a missing ``isinstance(list)`` guard turns
    ``"triage-ticket"`` into thirteen one-character skill names."""
    root = _manifest(tmp_path, json.dumps({"always_use_skills": "triage-ticket"}))
    assert read_bootstrap_manifest(root).always_use_skills == ()


def test_non_string_entries_are_dropped_without_raising(tmp_path):
    root = _manifest(tmp_path, json.dumps({"always_use_skills": [1, None, {"n": "x"}, "real-skill"]}))
    assert read_bootstrap_manifest(root).always_use_skills == ("real-skill",)


def test_repeats_collapse(tmp_path):
    root = _manifest(tmp_path, json.dumps({"always_use_skills": ["a", "a", " a ", "b"]}))
    assert read_bootstrap_manifest(root).always_use_skills == ("a", "b")


def test_a_long_list_is_capped(tmp_path):
    """Bounded so one manifest cannot bloat every system prompt in the project."""
    root = _manifest(tmp_path, json.dumps({"always_use_skills": [f"s{i}" for i in range(50)]}))
    assert len(read_bootstrap_manifest(root).always_use_skills) == MAX_ALWAYS_USE_SKILLS


def test_malformed_json_declares_nothing(tmp_path):
    root = _manifest(tmp_path, "{not json")
    assert read_bootstrap_manifest(root).always_use_skills == ()


def test_a_non_object_top_level_declares_nothing(tmp_path):
    root = _manifest(tmp_path, "[]")
    assert read_bootstrap_manifest(root).always_use_skills == ()


def test_declaring_only_skills_still_makes_the_manifest_truthy(tmp_path):
    """``__bool__`` gates whether callers bother acting on a manifest at all; a
    manifest whose ONLY declaration is this one must not read as empty."""
    root = _manifest(tmp_path, json.dumps({"always_use_skills": ["triage-ticket"]}))
    assert bool(read_bootstrap_manifest(root)) is True
