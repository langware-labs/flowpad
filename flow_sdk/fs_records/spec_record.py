"""SpecRecord — represents a spec backed by a markdown file with YAML frontmatter.

Source: <project>/specs/<spec_uname>/spec.md
Each spec is a folder containing a single spec.md with YAML frontmatter fields:
  title, spec_type, author_id, plan_id
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.fs_ref import FSRef


def _spec_id(path: Path) -> str:
    """UUID5 from resolved file path — stable across rescans."""
    return str(uuid.uuid5(uuid.NAMESPACE_URL, str(path.resolve())))


def _spec_search_dirs() -> list[Path]:
    """Return <project>/specs/ directories for all known Claude project paths."""
    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    dirs: list[Path] = []
    seen: set[Path] = set()
    for real in iter_claude_project_paths():
        p = real / "specs"
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)
    return dirs


class SpecRecord(Record):
    """A spec backed by <project>/specs/<spec_uname>/spec.md (markdown + YAML frontmatter)."""

    _record_type: ClassVar[str] = RecordType.SPEC
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _icon: ClassVar[str] = "FileText"
    index_fields: ClassVar[list[str]] = ["name", "spec_type"]

    @classmethod
    def _from_md_file(cls, path: Path) -> "SpecRecord":
        """Construct a SpecRecord from a spec.md file path."""
        spec_uname = path.parent.name
        name = spec_uname
        spec_type = "plan"
        try:
            text = path.read_text(encoding="utf-8")
            if text.startswith("---"):
                end = text.find("---", 3)
                if end != -1:
                    fm_text = text[3:end].strip()
                    for line in fm_text.splitlines():
                        if line.startswith("title:"):
                            name = line.split(":", 1)[1].strip().strip('"')
                        elif line.startswith("spec_type:"):
                            spec_type = line.split(":", 1)[1].strip()
        except OSError:
            pass
        rec = cls(id=_spec_id(path), name=name, spec_type=spec_type)
        object.__setattr__(rec, "_asset_ref", FSRef(path))
        return rec

    @property
    def search_title(self) -> str | None:
        return self.name or None

    @property
    def search_content(self) -> str | None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None and ar.exists():
            try:
                return ar.read()
            except OSError:
                return None
        return None

    def compute_record_hash(self) -> str:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None and ar.exists():
            try:
                st = Path(ar.path).stat()
                payload = f"{st.st_mtime}:{st.st_size}"
                return hashlib.sha256(payload.encode()).hexdigest()[:16]
            except OSError:
                return "0" * 16
        return "0" * 16

    @classmethod
    async def from_fsref(cls, ref) -> list["SpecRecord"]:
        """Indexer entry point — construct from an FSRef emitted by spec_project_fn."""
        return [cls._from_md_file(ref._path)]

    def save(self) -> None:
        ar = object.__getattribute__(self, "_asset_ref")
        if ar is not None:
            content = object.__getattribute__(self, "__dict__").get("content")
            if content is not None:
                ar.write(content)
        super().save()
