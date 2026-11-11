"""Every tracked file of a skill's template goes into the wheel — dotfiles included.

setuptools resolves ``[tool.setuptools.package-data]`` with ``glob(pattern, recursive=True)``,
and ``glob``'s ``*`` never matches a name that starts with a dot. So a template's
``.env.example`` or ``.gitignore`` is in the repo and silently absent from every install: the
``web-app-builder`` template's ``setup.py`` then fails on the missing ``.env.example`` and the
agent rebuilds it by hand. Resolved here the way setuptools resolves it, against the files git
tracks.
"""

from __future__ import annotations

import glob
import os
import re
import subprocess
import tomllib
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
PACKAGE = ROOT / "flow_sdk"
#: A skill's template is copied verbatim into a user's project, so every file of it must ship.
TEMPLATE = re.compile(r"/\.claude/skills/[^/]+/template[^/]*/")


def _resolve(patterns: list[str]) -> set[str]:
    found: set[str] = set()
    for pattern in patterns:
        found.update(glob.glob(os.path.join(PACKAGE, pattern), recursive=True))
    return {os.path.relpath(path, ROOT) for path in found if os.path.isfile(path)}


def test_every_tracked_skill_template_file_is_package_data():
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["setuptools"]
    shipped = _resolve(config["package-data"]["flow_sdk"]) - _resolve(config["exclude-package-data"]["flow_sdk"])
    tracked = subprocess.run(
        ["git", "ls-files", "flow_sdk/system_projects"], cwd=ROOT, capture_output=True, text=True, check=True
    ).stdout.splitlines()
    templates = [path for path in tracked if TEMPLATE.search(path)]
    assert templates, "no skill template is tracked: the pattern below no longer finds them"
    excluded = _resolve(config["exclude-package-data"]["flow_sdk"])
    missing = [path for path in templates if path not in shipped and path not in excluded]
    assert not missing, f"tracked but not shipped in the wheel: {missing}"


#: A module reading a data file next to itself: ``Path(__file__).parent / "name.json"``.
_BESIDE = re.compile(r"""Path\(__file__\)(?:\.resolve\(\))?\.parent\s*/\s*["']([\w.-]+\.(?:json|md|txt|ya?ml))["']""")


def test_a_data_file_a_module_reads_beside_itself_is_package_data():
    """``core/webapp/default_handlings.json`` was read by every web app's recovery and setup-state, and was
    not in the wheel: on a cloud box ``micro_app/<id>/setup-state`` answered a 500 (No such file)."""
    config = tomllib.loads((ROOT / "pyproject.toml").read_text(encoding="utf-8"))["tool"]["setuptools"]
    shipped = _resolve(config["package-data"]["flow_sdk"]) - _resolve(config["exclude-package-data"]["flow_sdk"])
    read: set[str] = set()
    for module in PACKAGE.rglob("*.py"):
        if "system_projects" in module.parts:
            continue
        for name in _BESIDE.findall(module.read_text(encoding="utf-8", errors="replace")):
            if (module.parent / name).is_file():
                read.add(os.path.relpath(module.parent / name, ROOT))
    assert read, "no module reads a file beside itself: the pattern no longer finds them"
    assert not read - shipped, f"read beside a module but not shipped in the wheel: {sorted(read - shipped)}"
