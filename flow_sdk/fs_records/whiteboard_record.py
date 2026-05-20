"""WhiteboardRecord — folder-backed Excalidraw whiteboard asset."""

from __future__ import annotations

import os
import uuid
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record import Scope
from flow_sdk.instance_settings import get_instance_settings

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


WHITE_BOARD_MD = "WHITE_BOARD.md"
BOARD_JSON = "board.json"

_DEFAULT_MERMAID_STUB = "flowchart TD\n  %% empty whiteboard"

AUTO_BEGIN_MARKER = "<!-- BEGIN whiteboard:auto -->"
AUTO_END_MARKER = "<!-- END whiteboard:auto -->"


def _read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick ``id`` (or legacy ``asset_id``) from a parsed frontmatter dict."""
    raw = yaml_fields.get("id") or yaml_fields.get("asset_id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


def _resolve_whiteboard_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the whiteboard's display name: yaml.name first, else folder name."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name


def _whiteboard_id_from_name(name: str) -> str:
    """Stable uuid5 derived from the whiteboard name."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{RecordType.WHITEBOARD}:{name}"))


def _whiteboard_search_dirs() -> list[Path]:
    """Directories to scan for whiteboard folders."""
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        try:
            rp = p.resolve()
        except OSError:
            return
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    user_root = get_instance_settings().claude_home / "whiteboards"
    _add(user_root)

    try:
        from flow_sdk.config import flowpad_assistant_project_root
        _add(flowpad_assistant_project_root() / ".claude" / "whiteboards")
    except Exception:
        pass

    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for real in iter_claude_project_paths():
        _add(real / ".claude" / "whiteboards")

    _add(Path(os.getcwd()) / ".claude" / "whiteboards")

    for extra in os.environ.get("FLOWPAD_WHITEBOARD_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs


def _load_whiteboard_fm(whiteboard_dir: Path) -> dict[str, Any]:
    """Load frontmatter from WHITE_BOARD.md, returning {} if absent."""
    try:
        text = (whiteboard_dir / WHITE_BOARD_MD).read_text(encoding="utf-8")
    except OSError:
        return {}
    fm = _extract_frontmatter(text)
    if not fm:
        return {}
    parsed = _yaml_load(fm)
    return parsed if isinstance(parsed, dict) else {}


def _user_whiteboard_root() -> Path:
    """User-scope whiteboard root: ``<claude_home>/whiteboards``."""
    return get_instance_settings().claude_home / "whiteboards"


class WhiteboardRecord(Record):
    """A whiteboard record — folder containing WHITE_BOARD.md + board.json."""

    _record_type: ClassVar[str] = RecordType.WHITEBOARD
    _indexed_by_default: ClassVar[bool] = True
    _browseable: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Palette"
    index_fields: ClassVar[list[str]] = ["description"]

    _main_subdir: ClassVar[str] = ".claude/whiteboards"
    _main_layout: ClassVar[str] = "folder"

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.WHITEBOARD)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    def default_body(self, entity) -> "str | None":
        """Seed WHITE_BOARD.md with frontmatter + heading + empty mermaid stub."""
        name = (getattr(entity, "name", None) or "").strip()
        if not name:
            return None
        desc = (getattr(entity, "description", None) or "").strip()
        fm = _render_frontmatter({
            "id": entity.id,
            "name": name,
            "description": desc,
        })
        body = (
            f"# {name}\n\n"
            f"{AUTO_BEGIN_MARKER}\n"
            f"```mermaid\n{_DEFAULT_MERMAID_STUB}\n```\n"
            f"{AUTO_END_MARKER}\n"
        )
        return f"{fm}\n\n{body}"

    # -- FSRef accessors --

    @property
    def whiteboard_doc(self) -> "Any":  # FrontMatterFsRef | None
        """FrontMatterFsRef pointing at WHITE_BOARD.md inside the whiteboard folder."""
        from flow_sdk.fs_store.fs_ref import FrontMatterFsRef
        ar = self.asset_ref
        if ar is None:
            return None
        return FrontMatterFsRef(ar._path / WHITE_BOARD_MD)

    @property
    def board_ref(self) -> "Any":  # FSRef | None
        """FSRef pointing at board.json inside the whiteboard folder."""
        from flow_sdk.fs_store.fs_ref import FSRef
        ar = self.asset_ref
        if ar is None:
            return None
        return FSRef(ar._path / BOARD_JSON)

    @property
    def main_ref(self) -> "Any":  # FrontMatterFsRef | None
        """Primary content ref: delegates to whiteboard_doc."""
        return self.whiteboard_doc

    @property
    def search_content(self) -> str | None:
        """name + description + WHITE_BOARD.md body. Excludes board.json content
        (the embedded ``files`` map blows up FTS)."""
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        desc = getattr(self, "description", None) or self.yaml_fields.get("description")
        if desc:
            parts.append(str(desc))
        doc = self.whiteboard_doc
        if doc is not None and doc.exists():
            try:
                parts.append(doc.read())
            except Exception:
                pass
        return "\n".join(parts) if parts else None

    def wiki_body(self) -> str | None:
        """Read the WHITE_BOARD.md body for wiki link extraction."""
        doc = self.whiteboard_doc
        if doc is None or not doc.exists():
            return None
        try:
            return doc.read_body()
        except Exception:
            return None

    def _asset_paths(self):
        """Whiteboard inner files — dir mtime won't catch edits to these."""
        ar = self.asset_ref
        base_dir: Path | None = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return []
        paths = []
        for name in (WHITE_BOARD_MD, BOARD_JSON):
            p = base_dir / name
            if p.exists():
                paths.append(p)
        return paths

    @classmethod
    def asset_hash_for_ref(cls, ref) -> float:
        """Whiteboard folder — stat inner content files, since dir mtime
        doesn't update when a child's content is edited."""
        base = ref._path
        ts = 0.0
        for name in (WHITE_BOARD_MD, BOARD_JSON):
            try:
                ts = max(ts, (base / name).stat().st_mtime)
            except OSError:
                pass
        return ts

    @property
    def yaml_fields(self) -> dict[str, Any]:
        """Load YAML metadata from WHITE_BOARD.md frontmatter."""
        ar = self.asset_ref
        base_dir: Path | None = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return {}
        doc = self.whiteboard_doc
        if doc is not None:
            try:
                return doc.read_frontmatter()
            except Exception:
                return {}
        return {}

    def meta_dict(self) -> dict:
        """Mirror SkillRecord: surface freshest asset mtime as updated_date so
        FTS reflects inner-file edits."""
        result = super().meta_dict()
        try:
            import os as _os
            from datetime import datetime as _dt, timezone as _tz
            mr = self.main_ref
            if mr is not None:
                p = mr._path
                result["updated_date"] = _dt.fromtimestamp(_os.path.getmtime(p), tz=_tz.utc).isoformat()
        except Exception:
            pass
        return result

    def read_record(self, path: Path) -> None:
        """Read whiteboard record -- bootstraps from frontmatter when JSON is absent."""
        if path.exists():
            super().read_record(path)
            return
        folder = path.parent
        if not folder.is_dir():
            return
        fm = _load_whiteboard_fm(folder)
        wb_name = _resolve_whiteboard_name(fm, folder.name)
        _d = object.__getattribute__(self, "__dict__")
        _d["id"] = _read_frontmatter_id_from_yaml(fm) or _whiteboard_id_from_name(wb_name)
        _d["name"] = wb_name
        _d["type"] = RecordType.WHITEBOARD
        _d["status"] = "active"
        if isinstance(fm.get("description"), str):
            object.__setattr__(self, "description", fm["description"])
        if fm:
            object.__setattr__(self, "metadata", fm)

    @classmethod
    def load_record(cls, path: str | Path) -> "WhiteboardRecord":
        """Load a whiteboard record from a path, with frontmatter bootstrap for whiteboard dirs."""
        from flow_sdk.fs_store.record import _META_JSON
        from flow_sdk.fs_store.fs_ref import FSRef

        p = Path(path)
        if not p.is_dir():
            return super().load_record(path)

        # Shadow record dir — load normally. asset_ref MUST come from
        # metadata.json["asset_ref"]; never overwrite with the shadow path.
        if (p / _META_JSON).exists() or (p / "data.json").exists():
            return super().load_record(path)

        # Frontmatter bootstrap for live whiteboard dirs.
        fm = _load_whiteboard_fm(p)
        wb_name = _resolve_whiteboard_name(fm, p.name)

        data: dict[str, Any] = {
            "id": _read_frontmatter_id_from_yaml(fm) or _whiteboard_id_from_name(wb_name),
            "name": wb_name,
            "type": RecordType.WHITEBOARD,
            "status": "active",
        }
        if isinstance(fm.get("description"), str):
            data["description"] = fm["description"]
        if fm:
            data["metadata"] = fm
        rec = cls.from_dict(data)
        object.__setattr__(rec, "_asset_ref", FSRef(p.resolve()))
        return rec

    @classmethod
    async def from_fsref(cls, ref) -> list["WhiteboardRecord"]:
        """Indexer entry point — construct from an FSRef emitted by whiteboard_fn."""
        from flow_sdk.fs_store.fs_ref import FSRef as _FSRef
        rec = cls.load_record(ref._path)
        if ref.scope:
            try:
                object.__setattr__(rec, "scope", Scope(ref.scope))
            except (ValueError, TypeError):
                pass
        if rec.asset_ref is None:
            object.__setattr__(rec, "_asset_ref", _FSRef(ref._path.resolve()))
        return [rec]

    @classmethod
    def getId(cls, ref) -> str:
        """Read-only identifier.

        Prefers frontmatter ``id`` (or legacy ``asset_id``) when present in
        WHITE_BOARD.md — that's the stable, file-bound id. Otherwise falls
        back to ``load_record`` semantics.
        """
        try:
            if ref._path.is_dir():
                fm = _load_whiteboard_fm(ref._path)
                fm_id = _read_frontmatter_id_from_yaml(fm)
                if fm_id:
                    return fm_id
            rec = cls.load_record(ref._path)
            return str(rec.id)
        except Exception:
            folder_name = ref._path.name
            return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name

    @classmethod
    def genId(cls, ref) -> str:
        """Read existing id, or mint+write a stable one into WHITE_BOARD.md frontmatter.

        Idempotent. If the file already has an id, no write happens.
        """
        if not ref._path.is_dir():
            return cls.getId(ref)
        fm = _load_whiteboard_fm(ref._path)
        existing = _read_frontmatter_id_from_yaml(fm)
        if existing:
            return existing
        wb_name = _resolve_whiteboard_name(fm, ref._path.name)
        new_id = _whiteboard_id_from_name(wb_name)
        doc = ref._path / WHITE_BOARD_MD
        if not doc.exists():
            return new_id
        try:
            text = doc.read_text(encoding="utf-8")
        except OSError:
            return new_id
        fm_text = _extract_frontmatter(text)
        body = _extract_body(text)
        fields: dict = {}
        if fm_text:
            parsed = _yaml_load(fm_text)
            if isinstance(parsed, dict):
                fields.update(parsed)
        merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
        try:
            doc.write_text(
                _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
                encoding="utf-8",
            )
        except OSError:
            pass
        return new_id

    @classmethod
    def get(cls, uid: str, **kwargs: Any) -> "WhiteboardRecord | None":
        """Find a whiteboard by uid: records_root first, then on-disk dirs."""
        rec = super().get(uid, **kwargs)
        if rec is not None:
            return rec
        for rec in cls.discover():
            if rec.id == uid:
                return rec
        return None

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list["WhiteboardRecord"]:
        """Discover all whiteboard directories from user and project .claude/whiteboards/ folders."""
        from flow_sdk.fs_store.fs_ref import FSRef
        results: list[WhiteboardRecord] = []
        seen: set[str] = set()
        user_dir = _user_whiteboard_root().resolve()
        limit = kwargs.get("limit")
        for wb_dir in _whiteboard_search_dirs():
            is_user_dir = wb_dir.resolve() == user_dir
            rec_scope = Scope.USER if is_user_dir else Scope.PROJECT
            for entry in sorted(wb_dir.iterdir()):
                if not entry.is_dir():
                    continue
                if not (entry / WHITE_BOARD_MD).exists():
                    continue
                key = str(entry.resolve())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    rec = cls.load_record(entry)
                    object.__setattr__(rec, "scope", rec_scope)
                    if rec.asset_ref is None:
                        object.__setattr__(rec, "_asset_ref", FSRef(entry.resolve()))
                    results.append(rec)
                    if limit is not None and len(results) >= limit:
                        return results
                except Exception:
                    continue
        return results

    def __getattr__(self, item: str) -> Any:
        # Check _data first (via parent), then yaml_fields.
        try:
            return super().__getattr__(item)
        except AttributeError:
            pass
        yaml_data = object.__getattribute__(self, "yaml_fields")
        if item in yaml_data:
            return yaml_data[item]
        raise AttributeError(f"{self.__class__.__name__!s} has no attribute {item!r}")
