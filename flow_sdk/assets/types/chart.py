"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path
from typing import Any, get_args

from flow_sdk.assets.frontmatter import _extract_body, _extract_frontmatter, _yaml_load
from flow_sdk.assets.types.chart_spec import ChartFormat
from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType

CHART_MD = "CHART.md"

# Format source files: ``board.json`` (excalidraw), ``chart.json`` (sequence).
# A mermaid chart keeps its source in the ```mermaid``` block of CHART.md.
BOARD_JSON = "board.json"
CHART_JSON = "chart.json"

CHART_FORMATS: tuple[str, ...] = get_args(ChartFormat)
DEFAULT_CHART_FORMAT = "excalidraw"


def chart_format(fm: dict) -> str:
    """The chart's format from its frontmatter; missing/unknown → excalidraw."""
    fmt = fm.get("format")
    return fmt if fmt in CHART_FORMATS else DEFAULT_CHART_FORMAT


def _resolve_chart_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the chart's display name: yaml.name first, else folder name."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name


def _parse_chart_fm(text: str) -> dict[str, Any]:
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    parsed = _yaml_load(fm)
    return parsed if isinstance(parsed, dict) else {}


def _load_chart_fm(chart_dir: Path) -> dict[str, Any]:
    """Load frontmatter from CHART.md, returning {} if absent."""
    try:
        return _parse_chart_fm((chart_dir / CHART_MD).read_text(encoding="utf-8"))
    except OSError:
        return {}


def chart_asset_hash(ref: FSRef) -> int:
    """mtime across every file inside the chart folder.

    Default base implementation uses dir mtime, which doesn't update when a
    child file's content is edited. Charts are folder-based and each format
    keeps a different source file, so this stats all inner files.
    """
    ts = 0
    try:
        children = list(ref._path.iterdir())
    except OSError:
        return 0
    for child in children:
        try:
            if child.is_file():
                ts = max(ts, child.stat().st_mtime_ns)
        except OSError:
            pass
    return ts


def extract_chart(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a chart folder into a Record. Replaces ``ChartRecord._from_fsref_sync``.

    Eagerly populates: id, name, description, content (name + description +
    body for FTS), body (markdown body for wiki indexing), and metadata (full
    frontmatter dict). The base ``Record.search_content`` / ``wiki_body``
    defaults read ``self.content`` / ``self.body``, so FTS + wiki work
    without subclass overrides.
    """
    path = ref._path
    # One read of CHART.md feeds both the frontmatter and the body.
    text = ""
    try:
        text = (path / CHART_MD).read_text(encoding="utf-8")
    except OSError:
        pass
    fm = _parse_chart_fm(text) if text else {}
    chart_name = _resolve_chart_name(fm, path.name)
    description = ""
    if isinstance(fm.get("description"), str):
        description = fm["description"]

    # Body = CHART.md without frontmatter. Used for wiki link extraction
    # and as the searchable body chunk.
    body = _extract_body(text) if text else ""

    # Composite FTS body: name + description + CHART.md body. Excludes
    # the format source files (board.json's embedded files map blows up FTS).
    content_parts: list[str] = []
    if chart_name:
        content_parts.append(chart_name)
    if description:
        content_parts.append(description)
    if body:
        content_parts.append(body)
    content = "\n".join(content_parts) if content_parts else ""

    rec_kwargs: dict = {
        "type": RecordType.CHART,
        "id": resolved_id,
        "name": chart_name,
        "status": "active",
        "content": content,
        "body": body,
    }
    if description:
        rec_kwargs["description"] = description
    if fm:
        rec_kwargs["metadata"] = {**fm, "format": chart_format(fm)}
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
