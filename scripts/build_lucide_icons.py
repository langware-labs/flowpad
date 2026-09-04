#!/usr/bin/env python3
"""Cut the lucide pack's SVG files from the installed ``lucide-react``.

The ``lucide`` pack declares a family and enumerates nothing (see
``flow_sdk/icons/registry.py``), but a name is only *valid* if the backend
actually serves its artwork — that is what lets Python catch a typo and what
keeps the plain-HTML path from 404-ing. This script is how the served set is
kept equal to the used set.

It takes no hand-maintained list. It scans the codebase for every icon name that
is emitted, drops the ones the ``brands`` / ``flowpad`` packs already answer for,
and writes ``<kebab>.svg`` for each of the rest.

    uv run python scripts/build_lucide_icons.py            # write
    uv run python scripts/build_lucide_icons.py --check     # CI: fail if stale

Geometry is lucide's own, under its ISC licence; nothing here is redrawn.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from flow_sdk.icons.registry import kebab  # noqa: E402 — after the path insert

REPO = Path(__file__).resolve().parent.parent
LUCIDE_SRC = REPO / "ui" / "node_modules" / "lucide-react" / "dist" / "esm" / "icons"
OUT = REPO / "flow_sdk" / "server" / "icons" / "lucide" / "assets"

SVG_ATTRS = (
    'xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" '
    'stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"'
)


def emitted_names() -> dict[str, set[str]]:
    """Every icon name the codebase publishes -> the files it came from.

    The provenance is what makes a fence failure actionable: "GoogleDrive is not
    served" is a puzzle, "GoogleDrive, from gdrive/data_source.json" is a fix.
    ``tests/unit/test_icon_spec.py`` imports this so the check and the generator
    can never disagree about what counts as an emitted name.
    """
    names: dict[str, set[str]] = {}

    def add(name: object, where: str) -> None:
        if isinstance(name, str) and name and "/" not in name:  # a path is a location, not a name
            names.setdefault(name, set()).add(where)

    py_patterns = (
        re.compile(r'\bicon\s*=\s*"([A-Za-z0-9_.-]+)"'),
        re.compile(r'_icon\s*:\s*ClassVar\[[^\]]*\]\s*=\s*"([^"]+)"'),
        re.compile(r'icon_name\s*=\s*"([^"]+)"'),
    )
    for path in (REPO / "flow_sdk").rglob("*.py"):
        text = path.read_text(errors="ignore")
        for pattern in py_patterns:
            for found in pattern.findall(text):
                add(found, path.name)
    for path in (REPO / "flow_sdk").rglob("*.json"):
        if path.name not in ("data_source.json", "credential.json"):
            continue
        try:
            blob = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        add(blob.get("icon_name"), path.name)
        for value in (blob.get("channel_icon_names") or {}).values():
            add(value, path.name)
    # Sub-icon refs are names too: a pack that badges `lucide:history` onto its
    # glyphs needs that file served, and nothing else in the codebase mentions
    # it. Miss these and `@restore` resolves to a badge that 404s.
    for path in (REPO / "flow_sdk" / "server" / "icons").glob("*/icon_pack.json"):
        try:
            pack = json.loads(path.read_text())
        except (OSError, ValueError):
            continue
        for spec in pack.get("icons") or []:
            for ref in (spec.get("sub") or {}).values():
                if isinstance(ref, str):
                    add(ref.rpartition(".")[2], f"{path.parent.name} pack sub-icon")

    return names


def _node_body(js: str) -> str:
    """The ``__iconNode`` array's contents, by bracket balance."""
    start = js.index("__iconNode = [") + len("__iconNode = ")
    depth = 0
    for i in range(start, len(js)):
        if js[i] == "[":
            depth += 1
        elif js[i] == "]":
            depth -= 1
            if depth == 0:
                return js[start + 1 : i]
    raise ValueError("unbalanced __iconNode")


def _source(slug: str, depth: int = 0) -> str:
    """A slug's module, following lucide's deprecated-name re-exports
    (``bar-chart-3`` -> ``chart-column``)."""
    js = (LUCIDE_SRC / f"{slug}.js").read_text()
    alias = re.search(r"export \{ default \} from '\./([\w-]+)\.js'", js)
    if alias and depth < 5:
        return _source(alias.group(1), depth + 1)
    return js


def to_svg(slug: str) -> str:
    parts = []
    for tag, attrs in re.findall(r'"([a-zA-Z]+)",\s*\{(.*?)\}', _node_body(_source(slug)), re.S):
        rendered = []
        for match in re.finditer(r'(?:"([\w-]+)"|(\w+))\s*:\s*"((?:[^"\\]|\\.)*)"', attrs):
            key, value = (match.group(1) or match.group(2)), match.group(3)
            if key == "key":  # lucide's react reconciliation key, not an SVG attribute
                continue
            rendered.append(f'{re.sub(r"(?<=[a-z])(?=[A-Z])", "-", key).lower()}="{value}"')
        parts.append(f"<{tag} " + " ".join(rendered) + "/>")
    if not parts:
        raise ValueError(f"{slug}: no geometry")
    return f"<svg {SVG_ATTRS}>" + "".join(parts) + "</svg>\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--check", action="store_true", help="report staleness, write nothing")
    args = ap.parse_args()

    if not LUCIDE_SRC.is_dir():
        print(f"lucide-react not installed at {LUCIDE_SRC} — run `cd ui && npm install`", file=sys.stderr)
        return 2

    from flow_sdk.icons import IconRegistry

    registry = IconRegistry()
    covered = {
        key
        for pack in registry.packs
        if not pack.is_bundle
        for spec in pack.icons
        for key in (spec.kind, *spec.aliases)
    }

    wanted, unknown = {}, []
    for name in sorted(set(emitted_names()) - covered):
        slug = kebab(name)
        if (LUCIDE_SRC / f"{slug}.js").is_file():
            wanted[slug] = name
        else:
            unknown.append(name)

    OUT.mkdir(parents=True, exist_ok=True)
    existing = {p.stem for p in OUT.glob("*.svg")}
    stale = sorted(existing - set(wanted))
    written = []
    for slug in sorted(wanted):
        svg = to_svg(slug)
        target = OUT / f"{slug}.svg"
        if not target.is_file() or target.read_text() != svg:
            written.append(slug)
            if not args.check:
                target.write_text(svg)

    if unknown:
        print(f"NOT A LUCIDE NAME and no pack claims it ({len(unknown)}):", file=sys.stderr)
        for name in unknown:
            print(f"  {name}", file=sys.stderr)

    if args.check:
        if written or stale or unknown:
            print(f"stale: {len(written)} to write, {len(stale)} orphaned, {len(unknown)} unclaimed", file=sys.stderr)
            return 1
        print(f"up to date — {len(existing)} icons")
        return 0

    print(f"{len(wanted)} icons wanted, {len(written)} written, {len(stale)} orphaned: {stale or 'none'}")
    return 1 if unknown else 0


if __name__ == "__main__":
    raise SystemExit(main())
