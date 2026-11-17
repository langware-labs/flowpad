"""The mockify mock tree (skill script `tree.py`): one DFS walk, and a validator that names every broken link."""

import importlib.util
from pathlib import Path

import pytest

_PATH = Path(__file__).parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/mockify/scripts/tree.py"
_spec = importlib.util.spec_from_file_location("mockify_tree", _PATH)
tree = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(tree)


def _screen(sid, *actions, **extra):
    return {"id": sid, "title": sid, "app": "X", "actions": list(actions), **extra}


def _go(aid, to, kind="main", **extra):
    return {"id": aid, "label": aid, "does": "", "to": to, "kind": kind, **extra}


def _mock():
    return {"tree": {"root": "home", "vars": [{"name": "desk", "values": ["off", "on"], "initial": "off"}], "screens": [
        _screen("home", _go("add", "form")),
        _screen("form", _go("cancel", "denied", "branch", when="if cancelled"), _go("save", "done", set=["desk=on"]), tag="new"),
        _screen("denied", _go("again", "form", "jump")),
        _screen("done", state=["desk=on"]),
    ]}}


def test_dfs_walks_branches_before_the_continuation_and_numbers_them():
    assert tree.validate(_mock()) == []
    walk = tree.compile_tree(_mock())["screens"]
    assert [(n["id"], n["num"], n["depth"]) for n in walk] == [("home", "1", 0), ("form", "2", 0), ("denied", "2a", 1), ("done", "3", 0)]
    assert [n["state"]["desk"] for n in walk] == ["off", "off", "off", "on"]   # a new screen is walked like any other


@pytest.mark.parametrize("break_it, says", [
    (lambda t: t["screens"].append(_screen("orphan")), "orphan: not reachable"),
    (lambda t: t["screens"][0]["actions"].append(_go("also", "done")), "2 main actions"),
    (lambda t: t["screens"][2]["actions"].append(_go("dup", "done", "branch", when="x")), "done: two parents"),
    (lambda t: t["screens"][1]["actions"][0].pop("when"), "a branch says `when`"),
    (lambda t: t["screens"][0]["actions"][0].update(to="nowhere"), "which is not a screen"),
    (lambda t: t["screens"][1]["actions"][1].update(set=["desk=maybe"]), "desk='maybe' is not one of"),
    (lambda t: t["screens"][3].update(state=["desk=off"]), "asserts desk=off but the way here leaves desk=on"),
    (lambda t: t["screens"][2]["actions"][0].update(set=["desk=on"]), "jumps to form with desk=on"),
    (lambda t: t["screens"][2].update(actions=[]), "denied: no action goes anywhere"),
])
def test_validate_names_the_broken_link(break_it, says):
    mock = _mock()
    break_it(mock["tree"])
    assert any(says in problem for problem in tree.validate(mock)), tree.validate(mock)


def test_a_legacy_journey_becomes_the_same_tree():
    legacy = {"journey": [
        {"id": "home", "app": "X", "title": "Home", "controls": [{"label": "Add", "does": "", "next": "form"}]},
        {"id": "form", "app": "X", "title": "Form", "path": "suggested", "controls": []},
        {"id": "denied", "app": "X", "title": "Denied", "branch_of": "form", "when": "if cancelled", "next": "form", "controls": []},
        {"id": "done", "app": "X", "title": "Done", "controls": []},
    ]}
    assert tree.validate(legacy) == []
    assert [(n["id"], n["num"], n["tag"]) for n in tree.compile_tree(legacy)["screens"]] == [
        ("home", "1", "existing"), ("form", "2", "new"), ("denied", "2a", "existing"), ("done", "3", "existing")]
