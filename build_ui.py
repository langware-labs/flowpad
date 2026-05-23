#!/usr/bin/env python3
"""Build the Flow UI and copy to dist/ for production serving."""

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).parent
UI_DIR = REPO_ROOT / "ui"
SYSTEM_PROJECTS_DIR = REPO_ROOT / "flow_sdk" / "system_projects"
_IS_WINDOWS = platform.system() == "Windows"


def get_dist_dir() -> Path:
    """Return flow_sdk/server/static — the production serving directory."""
    return REPO_ROOT / "flow_sdk" / "server" / "static"


def clean_dist():
    """Remove and recreate dist/."""
    dist = get_dist_dir()
    if dist.exists():
        shutil.rmtree(dist)
    dist.mkdir()
    print(f"Cleaned {dist}")


def install_ui_deps():
    """Run `npm install` in ui/."""
    print("Installing UI dependencies...")
    subprocess.run(["npm", "install"], cwd=UI_DIR, check=True, shell=_IS_WINDOWS)


def build_ui(port: int = 9007):
    """Run `npm run build` in ui/ with VITE_API_URL set."""
    api_url = f"http://localhost:{port}"
    print(f"Building UI with API URL: {api_url}")
    env = {**os.environ, "VITE_API_URL": api_url, "DEPLOY_ENV": "desktop", "IS_PACKAGE": "true"}
    subprocess.run(["npm", "run", "build"], cwd=UI_DIR, check=True, env=env, shell=_IS_WINDOWS)


def copy_to_dist():
    """Copy ui/dist/* → server/static/."""
    src = UI_DIR / "dist"
    dest = get_dist_dir()
    if not src.exists():
        print(f"ERROR: UI build output not found at {src}", file=sys.stderr)
        sys.exit(1)
    # Copy contents of ui/dist into server static
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)
    print(f"Copied build output to {dest}")


def discover_skill_ui_projects() -> list[Path]:
    """Find every `<system_project>/.claude/skills/<uname>/ui/` that has a package.json."""
    if not SYSTEM_PROJECTS_DIR.exists():
        return []
    return sorted(SYSTEM_PROJECTS_DIR.glob("*/.claude/skills/*/ui/package.json"))


def build_skill_uis():
    """Run `npm install` + `npm run build` in each skill's ui/ directory.

    The built `main.html` lands inside the skill folder and is picked up by the
    wheel via the `system_projects/**/*` package-data glob in pyproject.toml
    (which excludes node_modules/ and dist/ to keep the wheel slim).
    """
    pkg_files = discover_skill_ui_projects()
    if not pkg_files:
        print("No skill UI projects found.")
        return
    for pkg in pkg_files:
        ui_dir = pkg.parent
        skill_name = ui_dir.parent.name
        print(f"Building skill UI: {skill_name} ({ui_dir.relative_to(REPO_ROOT)})")
        # Always install — skipping when node_modules exists hides dep drift
        # when a skill's package.json gains/loses a dependency between builds.
        subprocess.run(["npm", "install"], cwd=ui_dir, check=True, shell=_IS_WINDOWS)
        subprocess.run(["npm", "run", "build"], cwd=ui_dir, check=True, shell=_IS_WINDOWS)


def build(port: int = 9007):
    """Full pipeline: clean → install → build skill UIs → build main UI → copy."""
    clean_dist()
    install_ui_deps()
    build_skill_uis()
    build_ui(port)
    copy_to_dist()
    print("Build complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Flow UI")
    parser.add_argument("--port", type=int, default=9007, help="API server port (default: 9007)")
    args = parser.parse_args()
    build(port=args.port)
