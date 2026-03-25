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


def build(port: int = 9007):
    """Full pipeline: clean → install → build → copy."""
    clean_dist()
    install_ui_deps()
    build_ui(port)
    copy_to_dist()
    print("Build complete.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Build the Flow UI")
    parser.add_argument("--port", type=int, default=9007, help="API server port (default: 9007)")
    args = parser.parse_args()
    build(port=args.port)
