"""Turn every whiteboard into a chart.

The WHITEBOARD entity was replaced by ONE entity, CHART, carrying a ``format``
(``sequence`` / ``excalidraw`` / ``mermaid``). A whiteboard is an excalidraw
chart, so each ``<root>/agentic-assets/whiteboard/<name>/`` moves to
``<root>/agentic-assets/chart/<name>/`` and its ``WHITE_BOARD.md`` becomes
``CHART.md`` with ``format: excalidraw`` added to the frontmatter. The walker
for the old family was removed with the type, so without this script existing
whiteboards would stop being indexed.

Approved by the user on 2026-10-15 (whiteboard → chart plan).

Contract:
* MOVE semantics, per asset — a whiteboard moves only when its chart
  destination does not already exist. Collisions are left in place and
  reported, never overwritten.
* Ids are untouched — the frontmatter ``id:`` travels with the document.
* Idempotent — once ``agentic-assets/whiteboard`` is gone (or empty) every
  later run is a no-op. A chart folder still holding a ``WHITE_BOARD.md`` (an
  interrupted run) is finished on the next run.
* Roots: the user asset root and every project mount (the 0.2.112 precedent).

Entry point: ``run()``. The runner calls it with no args.
"""

from __future__ import annotations

import json
import logging
import re
import shutil
import sqlite3
from dataclasses import dataclass, field
from pathlib import Path

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR

logger = logging.getLogger(__name__)

LEGACY_REL = f"{AGENTIC_ASSETS_DIR}/whiteboard"
DEST_REL = f"{AGENTIC_ASSETS_DIR}/chart"
LEGACY_MAIN = "WHITE_BOARD.md"
CHART_MAIN = "CHART.md"

_FRONTMATTER = re.compile(r"\A---[ \t]*\r?\n(.*?)^---[ \t]*\r?$", re.DOTALL | re.MULTILINE)
_FORMAT_LINE = re.compile(r"^format\s*:", re.MULTILINE)
_LEGACY_MARKER = re.compile(r"<!-- (BEGIN|END) whiteboard:auto -->")


@dataclass
class RootReport:
    """What happened under one scope root."""

    root: Path
    scope: str
    moved: list[tuple[str, str]] = field(default_factory=list)
    collisions: list[str] = field(default_factory=list)

    @property
    def touched(self) -> bool:
        return bool(self.moved or self.collisions)


def _with_format(text: str) -> str:
    """Add ``format: excalidraw`` to the document's frontmatter (or give it one).

    Text-level, not a YAML round-trip: the rest of the frontmatter (the id
    above all) stays byte-identical.
    """
    match = _FRONTMATTER.match(text)
    if match is None:
        return f"---\nformat: excalidraw\n---\n\n{text}"
    if _FORMAT_LINE.search(match.group(1)):
        return text
    end = match.end(1)
    return f"{text[:end]}format: excalidraw\n{text[end:]}"


def _convert_main(folder: Path) -> None:
    """``WHITE_BOARD.md`` → ``CHART.md`` with the format declared and the auto block's markers renamed."""
    legacy = folder / LEGACY_MAIN
    if not legacy.is_file():
        return
    target = folder / CHART_MAIN
    if target.exists():
        return
    text = _LEGACY_MARKER.sub(r"<!-- \1 chart:auto -->", legacy.read_text(encoding="utf-8"))
    target.write_text(_with_format(text), encoding="utf-8")
    legacy.unlink()


def _project_mounts() -> list[Path]:
    """Every project's on-disk mount, read straight from sqlite (0.2.112 shape)."""
    from flow_sdk.db.drivers.sqlite.connection import open_sqlite
    from flow_sdk.fs_store.path_utils import is_valid_project_cwd
    from flow_sdk.instance_settings import get_instance_settings

    db_path = get_instance_settings().db_path
    if not db_path or not Path(db_path).exists():
        return []
    try:
        conn = open_sqlite(db_path)
    except sqlite3.Error:
        return []
    out: list[Path] = []
    try:
        for row in conn.execute("SELECT data FROM entities WHERE type='project'").fetchall():
            if not row[0]:
                continue
            try:
                data = json.loads(row[0])
            except (json.JSONDecodeError, TypeError):
                continue
            mount = data.get("fs_storage_mount_path") or data.get("cwd")
            if mount and is_valid_project_cwd(mount) and Path(mount).is_dir():
                out.append(Path(mount))
    except sqlite3.Error:
        return out
    finally:
        conn.close()
    return out


def _migrate_root(root: Path, scope: str) -> RootReport:
    report = RootReport(root=root, scope=scope)
    legacy = root / LEGACY_REL
    dest = root / DEST_REL

    if legacy.is_dir():
        for child in sorted(legacy.iterdir()):
            target = dest / child.name
            if target.exists():
                # Never overwrite: a chart by this name already exists.
                report.collisions.append(f"{LEGACY_REL}/{child.name}")
                continue
            try:
                dest.mkdir(parents=True, exist_ok=True)
                shutil.move(str(child), str(target))
            except OSError as e:
                logger.warning("migrate 0.2.217: %s under %s failed: %s", child.name, root, e)
                continue
            report.moved.append((f"{LEGACY_REL}/{child.name}", f"{DEST_REL}/{child.name}"))
        try:
            if not any(legacy.iterdir()):
                legacy.rmdir()
        except OSError:
            pass

    # Convert every chart still carrying the legacy main doc — the ones just
    # moved, and any left half-done by an interrupted run.
    if dest.is_dir():
        for folder in sorted(dest.iterdir()):
            if folder.is_dir():
                try:
                    _convert_main(folder)
                except OSError as e:
                    logger.warning("migrate 0.2.217: %s under %s failed: %s", folder.name, root, e)
    return report


def run() -> list[RootReport]:
    """Migrate every scope root. Returns one report per root that changed."""
    from flow_sdk.instance_settings import get_instance_settings

    roots: list[tuple[Path, str]] = []
    # ``user_asset_root``, not ``user_home``: a non-prod instance keeps its user
    # repo assets in its own folder.
    user_root = get_instance_settings().user_asset_root
    if user_root and Path(user_root).is_dir():
        roots.append((Path(user_root), "user"))
    roots.extend((mount, "project") for mount in _project_mounts())

    touched = [r for r in (_migrate_root(root, scope) for root, scope in roots) if r.touched]

    total = sum(len(r.moved) for r in touched)
    if not total and not any(r.collisions for r in touched):
        print("whiteboard → chart migration: nothing to move.")
        return touched

    print(f"whiteboard → chart migration: moved {total} whiteboard(s) across {len(touched)} root(s).")
    for r in touched:
        print(f"  {r.scope}: {r.root}")
        for src, dst in r.moved:
            print(f"    {src} -> {dst}")
        for c in r.collisions:
            print(f"    SKIPPED (destination exists): {c}")
    return touched
