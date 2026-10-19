"""An app comes up ONE way: validate → load → setup → fix (``flow_sdk/core/setup/load.py:bring_up``).

The engine (``webapp_setup``) starts processes; everything else asks ``bring_up``. A new caller that starts
an app itself skips validate, the port rule its ``webapp.json`` declares, and the fixer — the PORT_HELD
``flow app open`` once hit. The places below still start one themselves, each for a reason named here.
"""
from __future__ import annotations

import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2] / "flow_sdk"
STARTS = re.compile(r"""start_detached\b|dev_server\.start_process\b|step\([^)]*["']start["'],\s*check=False""")
ALLOWED = {
    "core/dev_server.py": "defines the start helpers",
    "builtin/webapp_setup.py": "the engine: setup's own start step",
    "cli/commands/app_cmd.py": "a folder with no webapp.json has no setup flow to go through",
    "builtin/webapp_placement.py": "a cloud box's placement must never block on a setup question",
}


def test_nothing_but_the_engine_starts_an_app():
    found = {
        str(path.relative_to(ROOT))
        for path in ROOT.rglob("*.py")
        if "/tests/" not in str(path) and STARTS.search(path.read_text(encoding="utf-8", errors="ignore"))
    }
    assert found - set(ALLOWED) == set(), "start the app through bring_up (validate → load → setup → fix)"
