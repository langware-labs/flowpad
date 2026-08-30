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
    build_tokens_css(dest)
    print(f"Copied SDK bundle to {dest}")


# ── The served token stylesheet (/sdk/flowpad.css) ──────────────────────────
#: Tokens a served page cannot get any other way. The palette lives in
#: ``ui/src/styles/index.css`` and is extracted from it, so there is ONE source of
#: truth; everything below is what that file does NOT carry, because Tailwind
#: supplies it in the app: the body font (preflight), the radius scale
#: (``tailwind.config.ts`` derives lg/md/sm from ``--radius``), and a reset.
TOKENS_CSS = REPO_ROOT / "ui" / "src" / "styles" / "index.css"

_FLOWPAD_CSS_PREAMBLE = """/* Flowpad design tokens for statically served pages. GENERATED by build_ui.py
   from ui/src/styles/index.css — do not edit; edit that file.

   A page served out of a folder cannot use the app's Tailwind build, so this
   sheet carries the same tokens as plain CSS. Colours are bare HSL triplets,
   used as hsl(var(--token)) exactly as the app uses them.

   Light is :root; dark is .dark, the class next-themes writes on <html>. A page
   shown inside Flowpad receives ?theme=light|dark — apply it to <html> before
   first paint so there is no flash. */
"""

_FLOWPAD_CSS_EXTRAS = """
:root {
  /* Not tokens in the app: Tailwind's preflight supplies the body font, and the
     radius scale is derived in tailwind.config.ts. A served page has neither.
     The stacks below are Tailwind's stock `font-sans` / `font-mono` verbatim,
     which is what the app uses — it declares no fontFamily override. */
  --font-sans: ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto,
    "Helvetica Neue", Arial, "Noto Sans", sans-serif, "Apple Color Emoji",
    "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji";
  --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas,
    "Liberation Mono", "Courier New", monospace;
  --radius-lg: var(--radius);
  --radius-md: calc(var(--radius) - 2px);
  --radius-sm: calc(var(--radius) - 4px);
  color-scheme: light dark;
}

*, *::before, *::after { box-sizing: border-box; }

body {
  margin: 0;
  font-family: var(--font-sans);
  background: hsl(var(--background));
  color: hsl(var(--foreground));
}

/* Controls, styled by ELEMENT so a page gets Flowpad's inputs and buttons
   without naming a class. This is the difference between a served app that
   merely uses the palette and one that looks like it belongs: every app was
   otherwise re-deriving the same four rules from the tokens by hand. Override
   freely — these are defaults, declared at element level so any class wins. */
button {
  font: inherit;
  font-weight: 500;
  padding: 0.4rem 0.8rem;
  border: 1px solid transparent;
  border-radius: var(--radius-sm);
  background: hsl(var(--primary));
  color: hsl(var(--primary-foreground));
  cursor: pointer;
}
button:hover { background: hsl(var(--primary) / 0.9); }
button:disabled { opacity: 0.5; cursor: default; }

input, select, textarea {
  font: inherit;
  padding: 0.4rem 0.55rem;
  color: hsl(var(--foreground));
  background: hsl(var(--background));
  border: 1px solid hsl(var(--input));
  border-radius: var(--radius-sm);
}
input::placeholder, textarea::placeholder { color: hsl(var(--muted-foreground)); }

:focus-visible {
  outline: 2px solid hsl(var(--ring));
  outline-offset: 2px;
}

img, svg, video { max-width: 100%; height: auto; }

@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.01ms !important;
    scroll-behavior: auto !important;
  }
}
"""


def extract_token_block(css: str, selector: str) -> str:
    """The `--x: y;` declarations of the FIRST `selector { … }` block in *css*.

    A deliberately small reader rather than a CSS parser: the two blocks it reads
    are hand-maintained, flat, and contain only custom properties. It raises
    rather than returning nothing, because a silently empty extraction ships a
    colourless app that looks broken in a way nobody attributes to the build.
    """
    marker = selector + " {"
    start = css.find(marker)
    if start < 0:
        raise ValueError(f"no `{selector} {{` block")
    body = css[start + len(marker) : css.index("}", start)]
    tokens = [line.strip() for line in body.splitlines() if line.strip().startswith("--")]
    if not tokens:
        raise ValueError(f"`{selector}` block declares no tokens")
    return "\n".join("  " + t for t in tokens)


def render_flowpad_css(css: str) -> str:
    """The full served stylesheet, from the app's own token source."""
    return (
        f"{_FLOWPAD_CSS_PREAMBLE}\n"
        f":root {{\n{extract_token_block(css, ':root')}\n}}\n\n"
        f".dark {{\n{extract_token_block(css, '.dark')}\n}}\n"
        f"{_FLOWPAD_CSS_EXTRAS}"
    )


def build_tokens_css(dest: Path | None = None) -> Path:
    """Write ``flowpad.css`` beside the SDK bundle.

    Standalone on purpose: it transforms a checked-in text file and needs no
    npm, so `python build_ui.py --tokens-only` refreshes every served page after
    a token edit without a full UI build. Served pages carry no colours of their
    own, so a checkout where this never ran renders them unstyled rather than
    merely stale.
    """
    dest = dest or (get_dist_dir() / "sdk")
    dest.mkdir(parents=True, exist_ok=True)
    out = dest / "flowpad.css"
    out.write_text(render_flowpad_css(TOKENS_CSS.read_text(encoding="utf-8")), encoding="utf-8")
    print(f"Wrote {out}")
    return out


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
    parser = argparse.ArgumentParser(description="Build the Flow UI")
    parser.add_argument(
        "--tokens-only",
        action="store_true",
        help="Regenerate /sdk/flowpad.css from the app's tokens and stop. Needs no npm.",
    )
    args = parser.parse_args()
    build_tokens_css() if args.tokens_only else build()
