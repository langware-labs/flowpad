"""The mockify build list (skill script `build_list.py`): an approved mock becomes ordered items, and done is earned."""

import importlib.util
import json
import sys
from pathlib import Path

import pytest

_SCRIPTS = Path(__file__).parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/mockify/scripts"
sys.path.insert(0, str(_SCRIPTS))
_spec = importlib.util.spec_from_file_location("mockify_build_list", _SCRIPTS / "build_list.py")
bl = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(bl)
sys.path.remove(str(_SCRIPTS))

REF = "--mocks_x--.mockify.mock.id.1"


def _go(aid, to, kind="main", **extra):
    return {"id": aid, "label": aid, "does": "", "to": to, "kind": kind, **extra}


def _row(status="approved", **form_extra):
    screens = [
        {"id": "home", "title": "Home", "app": "X", "actions": [_go("add", "form"), {"id": "settings", "label": "Settings", "does": ""}]},
        {"id": "form", "title": "Form", "app": "X",
         "actions": [_go("cancel", "denied", "branch", when="if cancelled"), _go("save", "done", set=["desk=on"])],
         "changes": [{"id": "c1", "title": "Shorter label"}, {"id": "c2", "title": "Extra field"}],
         "decisions": [{"id": "D1", "question": "One step or two?", "shown": "one"}], **form_extra},
        {"id": "denied", "title": "Denied", "app": "X", "actions": [_go("again", "form", "jump")]},
        {"id": "done", "title": "Done", "app": "X", "state": ["desk=on"]},
    ]
    tree = {"root": "home", "vars": [{"name": "desk", "values": ["off", "on"], "initial": "off"}], "screens": screens}
    return {"key": "demo", "ref": REF, "input": {"title": "Demo", "status": status, "tree": tree}}


def _fb(**fields):
    return {"input": {"mock": REF, "status": "addressed", "created": "2026-01-01T00:00:00Z", **fields}}


def _made(**kw):
    return bl.make(_row(), kw.pop("feedback", []), **kw)["rows"]


def _titles(rows):
    return [f"{r['input']['kind']}:{r['input']['step']}:{r['input']['ref']}" for r in rows]


def test_items_follow_the_walk_screen_by_screen():
    rows = _made()
    assert _titles(rows) == [
        "screen:home:None", "state:home:None", "action:home:add",
        "screen:form:None", "state:form:None", "change:form:c1", "change:form:c2", "decision:form:D1",
        "action:form:cancel", "action:form:save",
        "screen:denied:None", "state:denied:None", "action:denied:again",
        "screen:done:None", "state:done:None",
    ]
    assert [r["key"] for r in rows[:2]] == ["demo-001", "demo-002"]
    assert [r["input"]["n"] for r in rows] == list(range(1, 16))
    assert {r["input"]["status"] for r in rows} == {"todo"} and {r["input"]["mock"] for r in rows} == {REF}
    assert 'goes to 2a "Denied" [branch: if cancelled]' in rows[8]["input"]["title"]


def test_a_control_that_goes_nowhere_is_not_an_item():
    assert "action:home:settings" not in _titles(_made())


def test_a_rejected_change_is_not_built_and_a_picked_option_is_named():
    made = bl.make(_row(), [_fb(step="form", change="c1", vote="no", text="Rejected", status="open"),
                            _fb(step="form", change="c2", vote="yes", choice="B", text="Approved")])
    assert "change:form:c1" not in _titles(made["rows"])
    assert made["not_built"] == ['2 c1 "Shorter label": rejected']
    assert "option picked: B" in next(r["input"]["title"] for r in made["rows"] if r["input"]["ref"] == "c2")


def test_the_latest_verdict_on_a_change_wins():
    rows = _made(feedback=[_fb(step="form", change="c1", vote="no", created="2026-01-01T00:00:00Z"),
                           _fb(step="form", change="c1", vote="yes", created="2026-01-02T00:00:00Z")])
    assert "change:form:c1" in _titles(rows)


def test_a_decision_carries_its_answer_or_says_it_has_none():
    title = lambda rows: next(r["input"]["title"] for r in rows if r["input"]["kind"] == "decision")  # noqa: E731
    assert "answered: two steps" in title(_made(feedback=[_fb(step="form", decision="D1", text="two steps")]))
    assert "not answered -- build what the mock shows (one)" in title(_made())


@pytest.mark.parametrize("row, feedback, says", [
    (_row(status="in_review"), [], "not approved"),
    (_row(), [_fb(step="form", text="make it blue", status="submitted")], "1 comment.s. are not addressed"),
    (_row(), [_fb(step="form", change="c1", vote="no", text="wrong place", status="open")], "not addressed"),
    (_row(), [_fb(step="form", text="no status on it", status=None)], "not addressed"),
    (_row(actions=[_go("save", "nowhere")]), [], "tree has problems"),
    ({"input": _row()["input"]}, [], "no key / ref"),
])
def test_make_refuses(row, feedback, says):
    with pytest.raises(bl.Refused, match=says):
        bl.make(row, feedback)


def test_a_plain_verdict_waiting_to_be_sent_does_not_block():
    assert _made(feedback=[_fb(step="form", change="c2", vote="yes", text="Approved", status="submitted")])


def test_a_redraw_resets_only_the_screen_that_changed():
    page = '<section data-step="home">A</section><section class="s" data-step="form">B</section>'
    first = _made(html=page)
    worked = [{**r, "input": {**r["input"], "status": "matches", "where": "ui/Home.tsx", "shot": "data:image/png;base64,AA"}} for r in first]
    again = bl.make(_row(), [], html=page.replace(">B<", ">B2<"), existing=worked)["rows"]
    by = {(r["input"]["kind"], r["input"]["step"]): r["input"] for r in again}
    assert by[("screen", "home")]["status"] == "matches" and by[("screen", "home")]["shot"]
    assert by[("screen", "form")]["status"] == "todo" and "shot" not in by[("screen", "form")]
    assert by[("screen", "form")]["where"] == "ui/Home.tsx"       # where it lives is kept; the proof starts again
    assert by[("change", "form")]["status"] == "matches"          # the change row itself did not move


def test_the_journey_bar_after_the_last_screen_is_not_part_of_its_drawing():
    page = '<section data-step="home">A</section><section data-step="form">B</section><script>bar v1</script>'
    assert bl.sections(page) == bl.sections(page.replace("bar v1", "bar v2"))
    assert bl.sections(page)["form"] == '<section data-step="form">B</section>'


def test_an_item_the_mock_no_longer_has_is_dropped():
    old = _made() + [{"key": "demo-099", "input": {"kind": "action", "step": "home", "ref": "gone", "n": 99, "sig": "x", "status": "matches"}}]
    assert "action:home:gone" not in _titles(bl.make(_row(), [], existing=old)["rows"])


def test_next_is_the_first_item_still_open():
    rows = _made()
    assert bl.next_item(rows)["n"] == 1
    rows[0]["input"]["status"], rows[1]["input"]["status"] = "matches", "not_checked"
    assert bl.next_item(rows)["n"] == 3
    assert bl.next_item([{**r, "input": {**r["input"], "status": "matches"}} for r in rows]) is None


def test_set_keeps_the_order_and_asks_for_the_proof(tmp_path):
    rows = _made()
    shot = tmp_path / "home.png"
    shot.write_bytes(b"\x89PNG")
    with pytest.raises(bl.Refused, match="earlier screen"):
        bl.set_item(rows, 4, "built", where="ui/Form.tsx")
    with pytest.raises(bl.Refused, match="say where"):
        bl.set_item(rows, 1, "built")
    with pytest.raises(bl.Refused, match="needs the screenshot"):
        bl.set_item(rows, 1, "matches", where="ui/Home.tsx")
    with pytest.raises(bl.Refused, match="needs a note"):
        bl.set_item(rows, 1, "differs", where="ui/Home.tsx")
    done = bl.set_item(rows, 1, "matches", where="ui/Home.tsx", shot=str(shot))
    assert done["key"] == "demo-001" and done["input"]["shot"].startswith("data:image/png;base64,")
    assert bl.set_item(rows, 4, "flagged", note="cannot be one card")["input"]["status"] == "flagged"   # a flag is never out of order
    assert bl.set_item(rows, 4, "todo", where="ui/Form.tsx")["input"]["where"] == "ui/Form.tsx"          # planning ahead is allowed


@pytest.mark.parametrize("status, extra, blocks", [
    ("todo", {}, True), ("built", {"where": "a"}, True), ("differs", {"note": "two cards"}, True),
    ("flagged", {"note": "x"}, True), ("matches", {}, True), ("not_checked", {}, True),
    ("matches", {"shot": "data:image/png;base64,AA"}, False), ("not_checked", {"note": "needs a phone"}, False),
])
def test_report_is_done_only_when_every_item_is_proven(status, extra, blocks):
    rows = [{**r, "input": {**r["input"], "status": status, **extra}} for r in _made()]
    table, blocking = bl.report(rows)
    assert bool(blocking) is blocks
    assert table.count("\n") == len(rows) + 1
    if status == "differs":
        assert "differs: two cards" in table


def test_the_statuses_are_the_ones_the_kind_allows():
    kind = _SCRIPTS.parent / "schema/agentic-assets/data_schema/mockify/agentic-assets/data_schema/mockify.build_item/data_schema.json"
    assert json.loads(kind.read_text())["fields"]["status"]["shape"] == "enum:" + "|".join(bl.STATUSES)


def test_an_empty_list_is_not_done():
    assert bl.report([])[1] == ["the build list is empty"]
