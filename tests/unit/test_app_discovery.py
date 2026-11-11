from __future__ import annotations

import json

from flow_sdk.cli.app_discovery import discover_webapps


def test_discover_webapps_prefers_framework_frontend_over_static_page(tmp_path):
    frontend = tmp_path / "ui" / "sim" / "frontend"
    frontend.mkdir(parents=True)
    (frontend / "package-lock.json").write_text("{}", encoding="utf-8")
    (frontend / "package.json").write_text(
        json.dumps(
            {
                "name": "frontend",
                "scripts": {"dev": "next dev --port 3300"},
                "dependencies": {"next": "16.0.0", "react": "19.0.0"},
            }
        ),
        encoding="utf-8",
    )

    static = tmp_path / "acme-sim" / "project"
    static.mkdir(parents=True)
    (static / "index.html").write_text("<div>demo</div>", encoding="utf-8")

    candidates = discover_webapps(tmp_path, "open the app")

    assert candidates
    assert candidates[0].path == str(frontend)
    assert candidates[0].kind == "next"
    assert candidates[0].port == 3300
    assert candidates[0].start_cmd == "npm run dev"


def test_a_folder_inside_an_app_with_a_webapp_json_is_not_another_app(tmp_path):
    """An app's own ``static/`` has an ``index.html``, and served alone it is a bare static server that
    cannot take a POST. The app declares how it is served; its parts are not candidates of their own."""
    app = tmp_path / "agentic-assets" / "webapp" / "task-list"
    (app / "static").mkdir(parents=True)
    (app / "webapp.json").write_text(json.dumps({"name": "task-list"}), encoding="utf-8")
    (app / "static" / "index.html").write_text("<div>tasks</div>", encoding="utf-8")

    other = tmp_path / "site"
    other.mkdir()
    (other / "index.html").write_text("<div>plain site</div>", encoding="utf-8")

    for root in (tmp_path, app, app / "static"):
        paths = [candidate.path for candidate in discover_webapps(root, "task-list")]
        assert str(app / "static") not in paths, root
    assert [candidate.path for candidate in discover_webapps(tmp_path)] == [str(other)]
