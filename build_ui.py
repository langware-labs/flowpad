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
SDK_DIR = REPO_ROOT / "ts_sdk"
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


def build_ui():
    """Run `npm run build` in ui/ for the backend-served bundle.

    We do NOT pin a backend port here. The bundle produced for ``server/static``
    is served by the backend itself, which injects ``globalThis.__FLOWPAD_API_URL__``
    = its own origin into ``index.html`` at serve time (see
    ``flow_sdk/server/routes/ui.py``); the SDK honours that runtime override above
    the compile-time ``__API_URL__``. So whatever ``__API_URL__`` bakes is only a
    standalone fallback — it must not pin every install to one port. Setting
    ``VITE_API_URL`` here (as this used to, to ``http://localhost:9007``) is what
    baked :9007 into a bundle later served by a :9008 dev backend, so we drop it
    and let the build default decide the fallback."""
    print("Building UI (backend injects API origin at serve time)")
    env = {**os.environ, "DEPLOY_ENV": "desktop", "IS_PACKAGE": "true"}
    env.pop("VITE_API_URL", None)
    # The main bundle is large enough to blow node's default old-space heap
    # (vite build dies with "Reached heap limit / JS heap out of memory").
    # Give it room unless the caller already tuned NODE_OPTIONS.
    if "max-old-space-size" not in env.get("NODE_OPTIONS", ""):
        env["NODE_OPTIONS"] = " ".join(filter(None, [env.get("NODE_OPTIONS", ""), "--max-old-space-size=8192"]))
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


def build_sdk():
    """Build the ts_sdk library and place it at ``server/static/sdk/``.

    ``app.py`` has always mounted ``/sdk`` from that directory, but nothing ever
    populated it, so the mount was dead and apps had no way to import the SDK
    from the host. ts_sdk's own vite config already emits the lib bundle
    (``flowpad-sdk.*`` plus rolled-up types) — this just runs it and puts the
    output where the mount looks.

    Serving the SDK rather than having each app bundle its own copy is what
    keeps a served app in step with the backend that serves it.
    """
    if not (SDK_DIR / "src" / "index.ts").exists():
        print(f"No ts_sdk at {SDK_DIR}; skipping SDK build.")
        return
    print("Building ts_sdk library...")
    # Built with ui's toolchain (see ui/vite.sdk.config.ts): ts_sdk declares no
    # build script and no devDependencies of its own.
    subprocess.run(
        ["npx", "vite", "build", "--config", "vite.sdk.config.ts"],
        cwd=UI_DIR,
        check=True,
        env={**os.environ, "DEPLOY_ENV": "desktop", "IS_PACKAGE": "true"},
        shell=_IS_WINDOWS,
    )

    src = UI_DIR / "sdk-dist"
    if not src.exists():
        print(f"ERROR: SDK build output not found at {src}", file=sys.stderr)
        sys.exit(1)
    dest = get_dist_dir() / "sdk"
    dest.mkdir(parents=True, exist_ok=True)
    for item in src.iterdir():
        target = dest / item.name
        if item.is_dir():
            shutil.copytree(item, target, dirs_exist_ok=True)
        else:
            shutil.copy2(item, target)
    print(f"Copied SDK bundle to {dest}")


def build():
    """Full pipeline: clean → install → build skill UIs → build main UI → copy."""
    clean_dist()
    install_ui_deps()
    build_skill_uis()
    build_ui()
    copy_to_dist()
    # After copy_to_dist: clean_dist() wipes server/static wholesale, and
    # copy_to_dist writes into it, so the SDK has to land last or it would be
    # deleted by the very next build step.
    build_sdk()
    print("Build complete.")


if __name__ == "__main__":
    # No --port: the backend-served bundle is origin-relative (see build_ui()).
    argparse.ArgumentParser(description="Build the Flow UI").parse_args()
    build()
