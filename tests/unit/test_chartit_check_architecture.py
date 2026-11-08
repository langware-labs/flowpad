"""chartit's `check_architecture.py`: the check every architecture chart passes before it is shown."""
import importlib.util
import json
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/chartit"
_spec = importlib.util.spec_from_file_location("check_architecture", SKILL / "templates/architecture/check_architecture.py")
check_architecture = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_architecture)

EXAMPLE = json.loads((SKILL / "templates/architecture/example.architecture.json").read_text())


def _chart(tmp_path: Path, value: dict, charts=()) -> Path:
    root = tmp_path / "proj"
    folder = root / "agentic-assets" / "chart" / "arch"
    folder.mkdir(parents=True)
    (folder / "architecture.json").write_text(json.dumps(value))
    for name in charts:
        other = root / "agentic-assets" / "chart" / name
        other.mkdir(parents=True)
        (other / "CHART.md").write_text(f"---\nname: {name}\nformat: architecture\n---\n")
    return folder


def test_the_shipped_example_passes(tmp_path):
    result = check_architecture.check(_chart(tmp_path, EXAMPLE))
    assert result["ok"], result["errors"]


def test_bad_links_roles_steps_and_refs_are_errors(tmp_path):
    value = {
        "groups": [{"id": "g", "label": "G", "tiers": [{"id": "t", "label": "T", "parts": [
            {"id": "a", "label": "A", "role": "lambda", "step": 2, "ref": "nowhere"},
            {"id": "a", "label": "A2", "role": "db", "color": "red"}]}]}],
        "links": [{"from": "a", "to": "ghost"}],
        "steps": [{"n": 1, "text": "on no part"}],
    }
    errors = " | ".join(check_architecture.check(_chart(tmp_path, value))["errors"])
    for expected in ("role must be", "duplicate id 'a'", "unknown field 'color'", "'ghost' is no group",
                     "step 1 is on no part", "step 2 is on a part but not listed", "ref 'nowhere'"):
        assert expected in errors


def test_a_ref_to_a_chart_in_the_project_passes(tmp_path):
    value = {"groups": [{"id": "g", "label": "G", "parts": [{"id": "a", "label": "A", "role": "service", "ref": "inside"}]}]}
    assert check_architecture.check(_chart(tmp_path, value, charts=("inside",)))["ok"]
