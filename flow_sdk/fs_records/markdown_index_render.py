"""Pure IndexMdJson → index.md renderer. Deterministic, no I/O hidden in the
transform. The agent writes the JSON sidecar; this renders the markdown."""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, Field


# ── Schema ────────────────────────────────────────────────────────────────────


class FileEntry(BaseModel):
    name: str                                   # "config.md"
    rel_path: str                               # "config.md" (relative to folder)
    title: str                                  # H1 from file, or filename stem
    summary: str                                # one-line, ≤ 25 words, LLM-generated
    content_hash: str                           # sha256 hex
    size_bytes: int = 0


class SubfolderEntry(BaseModel):
    name: str                                   # "oauth"
    rel_path: str                               # "oauth"
    self_summary: str                           # ≤ 60 words; quoted verbatim from child's IndexMdJson.self_summary
    child_typeid: str                           # full TypeId of the child MarkdownIndex entity
    child_inputs_hash: str                      # for Merkle propagation


class IndexMdJson(BaseModel):
    """Canonical structured form of a folder index. Lives at ``index.md.json``."""

    schema_version: Literal[1] = 1

    # Identity (matches the MarkdownIndex entity)
    typeid: str                                 # "markdown_index-<uuid>"
    parent_ref: str = ""                        # parent MarkdownIndex TypeId; "" for root
    vault_root: str                             # absolute path to scan root
    folder_rel_path: str                        # relative to vault_root, "" for root
    folder_name: str                            # leaf name, e.g. "auth"

    # Merkle inputs
    inputs_hash: str
    template_version: int = 1
    prompt_version: int = 1

    # Content
    self_summary: str                           # ≤ 60 words — what the parent quotes
    files: list[FileEntry] = Field(default_factory=list)
    subfolders: list[SubfolderEntry] = Field(default_factory=list)

    # Provenance
    generated_at: str                           # ISO timestamp
    latest_process_ref: str = ""                # AgenticProcess typeid that produced this


# ── Pure render ───────────────────────────────────────────────────────────────


def _render_frontmatter(fields: dict[str, Any]) -> str:
    """Minimal YAML frontmatter dump — deterministic ordering, no fancy formats."""
    lines = ["---"]
    for key, value in fields.items():
        if value is None or value == "":
            lines.append(f"{key}: ''")
        elif isinstance(value, bool):
            lines.append(f"{key}: {'true' if value else 'false'}")
        elif isinstance(value, (int, float)):
            lines.append(f"{key}: {value}")
        else:
            # Strings — quote if they contain anything that needs it
            s = str(value)
            if any(c in s for c in (":", "#", "\n", "'", '"', "\\")):
                # Use double quotes with backslash escapes
                escaped = s.replace("\\", "\\\\").replace('"', '\\"')
                lines.append(f'{key}: "{escaped}"')
            else:
                lines.append(f"{key}: {s}")
    lines.append("---")
    return "\n".join(lines)


def render_index_md(data: IndexMdJson) -> str:
    """Render IndexMdJson to markdown."""
    fm = _render_frontmatter({
        "type": "markdown_index",
        "id": data.typeid,
        "inputs_hash": data.inputs_hash,
        "template_version": data.template_version,
        "prompt_version": data.prompt_version,
        "parent_ref": data.parent_ref,
        "vault_root": data.vault_root,
        "generated_at": data.generated_at,
        "latest_process_ref": data.latest_process_ref,
        "file_count": len(data.files),
        "subfolder_count": len(data.subfolders),
    })

    body: list[str] = [
        f"# {data.folder_name or 'Index'}",
        "",
        "## Self-Summary",
        f"> {data.self_summary or '(empty)'}",
        "",
    ]

    if data.files:
        body.append("## Files")
        for f in sorted(data.files, key=lambda x: x.rel_path):
            body.append(f"- [{f.title}]({f.rel_path}) — {f.summary}")
        body.append("")

    if data.subfolders:
        body.append("## Subfolders")
        for s in sorted(data.subfolders, key=lambda x: x.rel_path):
            body.append(f"- [{s.name}/]({s.name}/index.md) — {s.self_summary}")
        body.append("")

    return fm + "\n\n" + "\n".join(body)


# ── On-disk helpers ───────────────────────────────────────────────────────────


def write_pair(folder: Path, data: IndexMdJson, json_path: Path | None = None) -> tuple[Path, Path]:
    """Write JSON (canonical) + MD (rendered) atomically.

    ``json_path`` defaults to ``folder/index.md.json`` (sidecar layout). Pass
    a path under ``<records_data>/markdown_index/<id>/`` to keep the JSON
    internal-only — that's the entity record-folder layout we want long-term.

    Returns (md_path, json_path).
    """
    md_path = folder / "index.md"
    if json_path is None:
        json_path = folder / "index.md.json"

    json_path.parent.mkdir(parents=True, exist_ok=True)
    json_path.write_text(data.model_dump_json(indent=2), encoding="utf-8")

    md_path.parent.mkdir(parents=True, exist_ok=True)
    md_path.write_text(render_index_md(data), encoding="utf-8")

    return md_path, json_path


def load_index_md_json(path: Path) -> IndexMdJson | None:
    """Read the canonical JSON form. Returns None if missing / unparseable."""
    try:
        return IndexMdJson.model_validate_json(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def _cli(argv: list[str] | None = None) -> int:
    import sys
    args = argv if argv is not None else sys.argv[1:]
    if not args:
        print("usage: render <input.json> [<output.md>]", file=sys.stderr)
        return 2
    json_path = Path(args[0])
    data = load_index_md_json(json_path)
    if data is None:
        print(f"error: cannot read {json_path}", file=sys.stderr)
        return 1
    md = render_index_md(data)
    if len(args) >= 2:
        Path(args[1]).write_text(md, encoding="utf-8")
    else:
        sys.stdout.write(md)
    return 0


if __name__ == "__main__":
    raise SystemExit(_cli())
