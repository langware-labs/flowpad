"""Learned handlings: matched by code, written only when they match their proof, never silently lost."""

import json

import pytest

from flow_sdk.core.webapp import handling
from flow_sdk.core.webapp.failure import make, of_page
from flow_sdk.schema.data_spec.webapp_lifecycle_spec import FailureCode, FailurePhase, HandlingAction, WebappHandlingSpec


def test_an_app_handling_wins_over_shipped_and_builtin(tmp_path):
    failure = of_page("not_answering", "relay")
    assert handling.match(failure, []).id == "builtin:not-answering"
    own = WebappHandlingSpec(id="mine", fingerprint=failure.fingerprint, action=HandlingAction.NEEDS_PERSON, arg="x")
    assert handling.match(failure, [own]).id == "mine"


def test_shipped_defaults_ignore_dev_noise():
    hit = handling.match(of_page("Warning: Each child in a list should have a unique key", "console"), [])
    assert hit is not None and hit.action is HandlingAction.IGNORE
    assert handling.match(of_page("TypeError: boom", "page"), []) is None


def test_add_refuses_a_handling_that_does_not_match_its_proof(tmp_path):
    proof = of_page("TypeError: boom")
    with pytest.raises(ValueError, match="does not match"):
        handling.add(tmp_path, WebappHandlingSpec(id="h", pattern="^Nope", action=HandlingAction.RESTART), proof=proof)
    added = handling.add(tmp_path, WebappHandlingSpec(id="h", action=HandlingAction.RESTART), proof=proof)
    assert added.fingerprint == proof.fingerprint and added.learned_at
    assert [h.id for h in handling.load(tmp_path)] == ["h"]


def test_a_bad_file_is_an_error_never_an_empty_list(tmp_path):
    (tmp_path / "setup").mkdir()
    (tmp_path / "setup" / "webapp_handlings.json").write_text(json.dumps(
        {"version": 1, "handlings": [{"id": "ok", "pattern": "x", "action": "ignore"},
                                     {"id": "bad", "pattern": "y", "action": "ignore", "stray": 1}]}))
    with pytest.raises(handling.HandlingFileError):
        handling.load(tmp_path)


def test_the_old_rules_file_is_converted_once(tmp_path):
    (tmp_path / "setup").mkdir()
    (tmp_path / "setup" / "webapp_errors.json").write_text(json.dumps([
        {"id": "noise", "pattern": "^Warn", "action": "ignore"},
        {"id": "down", "pattern": "^Uncaught\\s*$", "source": "page", "action": "recover",
         "fix": "launch the local tenant from Admin"},
        {"id": "kick", "pattern": "stale", "action": "recover", "fix": "restart"},
    ]))
    loaded = {h.id: h for h in handling.load(tmp_path)}
    assert loaded["noise"].action is HandlingAction.IGNORE
    assert loaded["down"].action is HandlingAction.ESCALATE and "tenant" in loaded["down"].arg
    assert loaded["kick"].action is HandlingAction.RESTART
    assert not (tmp_path / "setup" / "webapp_errors.json").exists()
    assert handling.match(of_page("Uncaught ", "page"), list(loaded.values())).id == "down"


def test_count_records_whether_a_handling_held(tmp_path):
    proof = make(FailurePhase.START, FailureCode.EXITED, "died")
    handling.add(tmp_path, WebappHandlingSpec(id="r", action=HandlingAction.RESTART), proof=proof)
    handling.count(tmp_path, "r", fixed=True)
    handling.count(tmp_path, "r", fixed=False)
    (h,) = handling.load(tmp_path)
    assert (h.fixed, h.not_fixed) == (1, 1)
