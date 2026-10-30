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

# Format source files: ``board.json`` (excalidraw), ``chart.json`` (sequence), ``c4.json`` (c4).
# A mermaid chart keeps its source in the ```mermaid``` block of CHART.md.
BOARD_JSON = "board.json"
CHART_JSON = "chart.json"
C4_JSON = "c4.json"

CHART_FORMATS: tuple[str, ...] = get_args(ChartFormat)
DEFAULT_CHART_FORMAT = "excalidraw"

# The one table of formats: the file each keeps its source in, what an empty one holds,
# and which list in it carries icon tags. A new format is one row here (plus its view).
CHART_SOURCES: dict[str, tuple[str, str]] = {
    "sequence": (CHART_JSON, '{"participants": [], "messages": []}\n'),
    "excalidraw": (BOARD_JSON, '{"kind": "excalidraw", "version": 1, "data": {"elements": []}}\n'),
    "c4": (C4_JSON, '{"level": "context", "elements": [], "boundaries": [], "relations": []}\n'),
}
CHART_ICON_LISTS: dict[str, str] = {"sequence": "participants", "c4": "elements"}


def declared_chart_format(fm: dict) -> str:
    """The format as the chart declares it — kept on the row even when THIS build does not know it, so
    an editor can say "needs a newer Flowpad" instead of opening it as an empty whiteboard. Missing →
    the default."""
    fmt = fm.get("format")
    return fmt.strip() if isinstance(fmt, str) and fmt.strip() else DEFAULT_CHART_FORMAT


def chart_format(fm: dict) -> str:
    """The format THIS build draws the chart as: its declared one when known, else excalidraw."""
    fmt = declared_chart_format(fm)
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


def chart_icon_problems(chart_dir: Path, fmt: str = "sequence") -> list[str]:
    """Why a chart's icons will not render, one line each.

    Every icon in the format's icon list (``participants[]`` of a sequence,
    ``elements[]`` of a c4 chart) must resolve EXACTLY through the icon registry
    -- the built-in packs plus the icon pack assets of every scope above the
    chart (its project's ``agentic-assets/icon_pack/``). The view still draws a
    fallback glyph; this is what tells the author it is one."""
    import json  # noqa: PLC0415

    from flow_sdk.icons.registry import icon_ref_problem, icons  # noqa: PLC0415

    list_key = CHART_ICON_LISTS.get(fmt)
    if not list_key:
        return []
    try:
        doc = json.loads((chart_dir / CHART_SOURCES[fmt][0]).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return []
    participants = doc.get(list_key) if isinstance(doc, dict) else None
    if not isinstance(participants, list):
        return []
    kind = "participant" if fmt == "sequence" else "element"
    icons.add_near(chart_dir)
    problems: list[str] = []
    for p in participants:
        if not isinstance(p, dict):
            continue
        problem = icon_ref_problem(p.get("icon"))
        if problem:
            problems.append(f"{kind} {p.get('id') or p.get('label') or '?'}: {problem}")
    return problems


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
        # Row fields, not just metadata: the editor picks its view from the row's format
        # and sends feedback to the row's session.
        "format": declared_chart_format(fm),
    }
    if isinstance(fm.get("session"), str) and fm["session"]:
        rec_kwargs["session"] = fm["session"]
    if rec_kwargs["format"] in CHART_ICON_LISTS:
        rec_kwargs["problems"] = chart_icon_problems(path, rec_kwargs["format"])
    if description:
        rec_kwargs["description"] = description
    if fm:
        rec_kwargs["metadata"] = {**fm, "format": declared_chart_format(fm)}
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
