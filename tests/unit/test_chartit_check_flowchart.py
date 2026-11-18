"""chartit's `check_flowchart.py`: the check every flowchart chart passes before it is shown."""
import importlib.util
import json
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/chartit"
_spec = importlib.util.spec_from_file_location("check_flowchart", SKILL / "templates/flowchart/check_flowchart.py")
check_flowchart = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_flowchart)

EXAMPLE = json.loads((SKILL / "templates/flowchart/example.flowchart.json").read_text())


def _chart(tmp_path: Path, value: dict, charts=()) -> Path:
    root = tmp_path / "proj"
    folder = root / "agentic-assets" / "chart" / "flow"
    folder.mkdir(parents=True)
    (folder / "flowchart.json").write_text(json.dumps(value))
    for name in charts:
        other = root / "agentic-assets" / "chart" / name
        other.mkdir(parents=True)
        (other / "CHART.md").write_text(f"---\nname: {name}\nformat: sequence\n---\n")
    return folder


def test_the_shipped_example_passes(tmp_path):
    result = check_flowchart.check(_chart(tmp_path, EXAMPLE, charts=("order-shipping",)))
    assert result["ok"], result["errors"]
    assert not result["warnings"]


def test_a_question_without_state_or_labelled_exits_is_an_error(tmp_path):
    value = {
        "nodes": [
            {"id": "s", "kind": "start", "label": "Start"},
            {"id": "q", "kind": "question", "label": "Paid?"},
            {"id": "a", "kind": "outcome", "label": "Ship", "color": "red", "ref": "nowhere"},
            {"id": "a", "kind": "outcome", "label": "Twice"},
            {"id": "lost", "kind": "cloud", "label": "Never reached"},
        ],
        "edges": [{"from": "s", "to": "q"}, {"from": "q", "to": "a"}, {"from": "q", "to": "ghost", "label": "no"}],
    }
    errors = " | ".join(check_flowchart.check(_chart(tmp_path, value))["errors"])
    for expected in ("duplicate id 'a'", "unknown field 'color'", "kind must be", "'ghost' is no node",
                     "'lost' cannot be reached", "question 'q': missing `state`", "at least two exits",
                     "every exit needs a label", "ref 'nowhere'"):
        assert expected in errors


def test_two_starts_are_an_error_and_a_long_label_a_warning(tmp_path):
    value = {"nodes": [{"id": "a", "kind": "start", "label": "A"}, {"id": "b", "kind": "start", "label": "B" * 60}]}
    result = check_flowchart.check(_chart(tmp_path, value))
    assert "exactly one start node, found 2" in " | ".join(result["errors"])
    assert "keep it short" in " | ".join(result["warnings"])
