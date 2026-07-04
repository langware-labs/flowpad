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

    static = tmp_path / "spora-sim" / "project"
    static.mkdir(parents=True)
    (static / "index.html").write_text("<div>demo</div>", encoding="utf-8")

    candidates = discover_webapps(tmp_path, "open the app")

    assert candidates
    assert candidates[0].path == str(frontend)
    assert candidates[0].kind == "next"
    assert candidates[0].port == 3300
    assert candidates[0].start_cmd == "npm run dev"
