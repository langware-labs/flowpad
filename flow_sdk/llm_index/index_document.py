"""IndexDocument — the ``index.md`` flavor of :class:`MarkdownDocument`.

``index.md`` is the generated folder index (distinct from the folder note). Its
structured form is :class:`IndexData` — the source of truth, persisted as a
``index.md.json`` sidecar (stdlib json, no pydantic). The human-readable
``index.md`` is rendered deterministically from it through ``MarkdownDocument``,
so the same data always yields the same bytes (stable Merkle hashing).

Body layout::

    # <folder_name>

    ## Self-Summary
    > <self_summary>

    ## Files
    - [[oauth]] — <one-line summary>

    ## Subfolders
    - [[auth]] — <child self-summary>      ← [[name]] resolves to the child folder note
"""

from __future__ import annotations

import json
import os
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any

from flow_sdk.llm_index.markdown_document import MarkdownDocument

INDEX_FILENAME = "index.md"
SIDECAR_FILENAME = "index.md.json"
SCHEMA_VERSION = 1


@dataclass
class FileRef:
    name: str            # "oauth.md"
    title: str           # H1 or stem
    summary: str         # one-line, LLM-generated
    content_hash: str    # sha256 hex of the source bytes

    @property
    def link_name(self) -> str:
        """Wiki-link target for the file (stem, so [[oauth]])."""
        return Path(self.name).stem


@dataclass
class SubfolderRef:
    name: str                 # "auth"
    self_summary: str         # quoted from the child index, ≤60 words
    child_inputs_hash: str    # for provenance / debugging


@dataclass
class IndexData:
    """Canonical structured form of one folder index (the ``index.md.json``)."""

    typeid: str
    vault_root: str
    folder_rel_path: str
    folder_name: str
    inputs_hash: str
    self_summary: str
    generated_at: str
    parent_ref: str = ""
    template_version: int = 1
    prompt_version: int = 1
    latest_process_ref: str = ""
    schema_version: int = SCHEMA_VERSION
    files: list[FileRef] = field(default_factory=list)
    subfolders: list[SubfolderRef] = field(default_factory=list)

    # -- json round-trip --------------------------------------------------------

    def to_json(self) -> str:
        return json.dumps(asdict(self), indent=2, ensure_ascii=False)

    @classmethod
    def from_json(cls, text: str) -> "IndexData":
        raw: dict[str, Any] = json.loads(text)
        files = [FileRef(**f) for f in raw.pop("files", [])]
        subs = [SubfolderRef(**s) for s in raw.pop("subfolders", [])]
        return cls(**raw, files=files, subfolders=subs)


class IndexDocument:
    """Builder/loader tying :class:`IndexData` to a rendered ``index.md``."""

    FILENAME = INDEX_FILENAME
    SIDECAR = SIDECAR_FILENAME

    def __init__(self, data: IndexData):
        self.data = data

    # -- render -----------------------------------------------------------------

    def to_document(self) -> MarkdownDocument:
        d = self.data
        frontmatter: dict[str, Any] = {
            "type": "markdown_index",
            "id": d.typeid,
            "inputs_hash": d.inputs_hash,
            "template_version": d.template_version,
            "prompt_version": d.prompt_version,
            "parent_ref": d.parent_ref,
            "vault_root": d.vault_root,
            "generated_at": d.generated_at,
            "latest_process_ref": d.latest_process_ref,
            "file_count": len(d.files),
            "subfolder_count": len(d.subfolders),
        }
        lines: list[str] = [
            f"# {d.folder_name or 'Index'}",
            "",
            "## Self-Summary",
            f"> {d.self_summary or '(empty)'}",
            "",
        ]
        if d.files:
            lines.append("## Files")
            for f in sorted(d.files, key=lambda x: x.name):
                lines.append(f"- [[{f.link_name}]] — {f.summary}")
            lines.append("")
        if d.subfolders:
            lines.append("## Subfolders")
            for s in sorted(d.subfolders, key=lambda x: x.name):
                lines.append(f"- [[{s.name}]] — {s.self_summary}")
            lines.append("")
        return MarkdownDocument(frontmatter=frontmatter, body="\n".join(lines))

    def render(self) -> str:
        return self.to_document().render()

    # -- disk -------------------------------------------------------------------

    def write(self, folder: Path | str) -> tuple[Path, Path]:
        """Write ``index.md`` (rendered) + ``index.md.json`` (canonical)."""
        folder = Path(folder)
        folder.mkdir(parents=True, exist_ok=True)
        md_path = folder / self.FILENAME
        json_path = folder / self.SIDECAR
        md_path.write_text(self.render(), encoding="utf-8")
        json_path.write_text(self.data.to_json(), encoding="utf-8")
        return md_path, json_path

    def write_sidecar(self, json_path: Path | str) -> Path:
        """Write ONLY the canonical JSON, atomically (`*.tmp` + os.replace).

        Used for data-dir baselines (the native ``stamp``) — never touches the
        vault and never renders an ``index.md``.
        """
        json_path = Path(json_path)
        json_path.parent.mkdir(parents=True, exist_ok=True)
        tmp = json_path.with_suffix(json_path.suffix + ".tmp")
        tmp.write_text(self.data.to_json(), encoding="utf-8")
        os.replace(tmp, json_path)
        return json_path

    @classmethod
    def load(cls, folder: Path | str) -> "IndexDocument | None":
        """Load the canonical sidecar for ``folder``; ``None`` if absent/bad."""
        return cls.load_file(Path(folder) / cls.SIDECAR)

    @classmethod
    def load_file(cls, json_path: Path | str) -> "IndexDocument | None":
        """Load a sidecar from an explicit json path; ``None`` if absent/bad.

        Unknown/extra keys (e.g. legacy demo sidecars carrying ``rel_path`` /
        ``size_bytes`` per file) raise TypeError in the dataclass constructors
        and are deliberately treated as "no baseline".
        """
        try:
            return cls(IndexData.from_json(Path(json_path).read_text(encoding="utf-8")))
        except (OSError, ValueError, TypeError):
            return None
