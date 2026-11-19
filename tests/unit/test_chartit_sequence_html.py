"""chartit's sequence `export_html.py`: a sequence chart's one-file HTML copy."""
import importlib.util
import json
from pathlib import Path

SKILL = Path(__file__).resolve().parents[2] / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/chartit"
_spec = importlib.util.spec_from_file_location("export_html", SKILL / "templates/sequence/export_html.py")
export_html = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(export_html)

CHART = {
    "participants": [
        {"id": "app", "label": "Acme App", "sublabel": "Flutter app", "icon": "lucide.user", "note": "app/frontend"},
        {"id": "api", "label": "Tenant API", "sublabel": "Cloud Run", "icon": "no-such.icon"},
    ],
    "messages": [
        {"id": "m1", "from": "app", "to": "api", "label": "POST /oauth/init", "note": "routes.js:182"},
        {"id": "m2", "from": "api", "to": "api", "label": "buildAuthorizeUrl()"},
        {"id": "m3", "from": "api", "to": "app", "label": "Token refresh", "ref": "token-refresh", "returns": "fresh token"},
        {"id": "m4", "from": "api", "to": "nobody", "label": "dropped: no such participant"},
    ],
}


def test_the_html_copy_is_one_file_in_order_with_no_network(tmp_path):
    folder = tmp_path / "proj" / "agentic-assets" / "chart" / "flow"
    folder.mkdir(parents=True)
    (folder / "chart.json").write_text(json.dumps(CHART))
    (folder / "CHART.md").write_text("---\nname: flow\ndescription: A long value\n  folded onto two lines\n---\n")

    assert export_html.main([str(folder)]) == 0
    page = (folder / "flow.html").read_text()
    for text in ("Acme App", "Flutter app", "POST /oauth/init", "routes.js:182", "token-refresh", "fresh token"):
        assert text in page
    assert "A long value folded onto two lines" in page
    assert "dropped" not in page
    assert page.count('class="ico"') == 1  # the shipped icon is inlined; an unknown one is left out
    assert "https://" not in page and " src=" not in page and "@import" not in page

    rows = export_html.layout(export_html.read(folder))["rows"]
    assert [r["n"] for r in rows] == [1, 2, 3]
    assert all(a["y"] < b["y"] for a, b in zip(rows, rows[1:]))
