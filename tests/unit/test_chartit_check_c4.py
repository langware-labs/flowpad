"""chartit's `check_c4.py`: the check every C4 chart passes before it is shown."""
import importlib.util
import json
from pathlib import Path

import pytest

SCRIPT = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/chartit/templates/c4/check_c4.py"
)
_spec = importlib.util.spec_from_file_location("check_c4", SCRIPT)
check_c4 = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(check_c4)

GOOD = {
    "level": "code",
    "elements": [
        {"id": "engine", "kind": "code", "label": "PricingEngine", "boundary": "svc",
         "inputs": [{"name": "cart", "kind": "shop.cart"}], "returns": "shop.quote",
         "links": [{"label": "PricingEngine.kt", "href": "src/PricingEngine.kt:8"}], "ref": "zoom"},
        {"id": "user", "kind": "role", "label": "Admin"},
    ],
    "boundaries": [{"id": "svc", "label": "Order service", "kind": "container"}],
    "relations": [{"id": "r1", "from": "user", "to": "engine", "label": "Prices", "data": "shop.cart", "ref": "zoom"}],
}


def _project(tmp_path: Path, value: dict, kinds=("shop.cart", "shop.quote"), charts=("zoom",)) -> Path:
    root = tmp_path / "proj"
    for kind in kinds:
        d = root / "agentic-assets" / "data_schema" / kind
        d.mkdir(parents=True)
        (d / "data_schema.json").write_text('{"type": "data_schema", "fields": {}}')
    for name in charts:
        d = root / "agentic-assets" / "chart" / name
        d.mkdir(parents=True)
        (d / "CHART.md").write_text(f"---\nname: {name}\nformat: c4\n---\n")
    chart = root / "agentic-assets" / "chart" / "under-test"
    chart.mkdir(parents=True)
    (chart / "c4.json").write_text(json.dumps(value))
    return chart


def _bad(**changes):
    value = json.loads(json.dumps(GOOD))
    for path, v in changes.items():
        target, *keys = path.split("__")
        if not keys:
            value[target] = v
            continue
        node = value[target]
        for k in keys[:-1]:
            node = node[int(k)] if k.isdigit() else node[k]
        last = keys[-1]
        node[int(last) if last.isdigit() else last] = v
    return value


def test_a_good_chart_passes_with_no_warning(tmp_path):
    result = check_c4.check(_project(tmp_path, GOOD))
    assert result["ok"], result
    assert result["warnings"] == []


@pytest.mark.parametrize(
    "value, says",
    [
        (_bad(elements__0__kind="robot"), "kind 'robot'"),
        (_bad(relations__0__to="nobody"), "is not an element"),
        (_bad(elements__0__boundary="nowhere"), "boundary 'nowhere' does not exist"),
        (_bad(elements__0__links=[{"label": "no target"}]), "needs a label and an href or an asset"),
        (_bad(elements__0__inputs=[{"name": "cart"}]), "needs a name and a kind"),
        (_bad(elements__0__ref="missing-chart"), "no chart with that name"),
        (_bad(relations__0__ref="missing-chart"), "no chart with that name"),
        (_bad(elements__0__color="#f00"), "unknown field"),
        (_bad(level="sideways"), "level 'sideways'"),
    ],
)
def test_each_mistake_is_named(tmp_path, value, says):
    result = check_c4.check(_project(tmp_path, value))
    assert not result["ok"]
    assert any(says in e for e in result["errors"]), result["errors"]


def test_a_boundary_loop_is_an_error(tmp_path):
    value = json.loads(json.dumps(GOOD))
    value["boundaries"] = [{"id": "a", "label": "A", "parent": "b"}, {"id": "b", "label": "B", "parent": "a"}]
    value["elements"][0]["boundary"] = "a"
    result = check_c4.check(_project(tmp_path, value))
    assert any("loop" in e for e in result["errors"]), result["errors"]


def test_a_missing_data_type_and_an_empty_boundary_warn(tmp_path):
    value = json.loads(json.dumps(GOOD))
    value["boundaries"].append({"id": "empty", "label": "Nothing"})
    result = check_c4.check(_project(tmp_path, value, kinds=("shop.cart",)))
    assert result["ok"], result
    assert any("'shop.quote'" in w for w in result["warnings"])
    assert any("holds nothing" in w for w in result["warnings"])
