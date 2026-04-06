"""SkillitSkill -- a typed record for skills managed by skillit."""

from __future__ import annotations

import shutil
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record import Scope

from ._frontmatter import _coerce_scalar, _extract_frontmatter, _yaml_load  # noqa: F401


def _skill_search_dirs() -> list[Path]:
    """Return directories to scan for skill folders.

    Scans user-level (~/.claude/skills), all known Claude projects
    (<project>/.claude/skills), cwd-level, and any extra dirs from
    FLOWPAD_SKILL_DIRS (colon-separated).
    """
    import os
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    _add(Path.home() / ".claude" / "skills")

    from flow_sdk.fs_records._claude_projects import iter_claude_project_paths
    for real in iter_claude_project_paths():
        _add(real / ".claude" / "skills")

    _add(Path(os.getcwd()) / ".claude" / "skills")

    for extra in os.environ.get("FLOWPAD_SKILL_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs


def _load_skill_yaml_from_dir(skill_dir: Path) -> dict[str, Any]:
    yaml_sources = [skill_dir / "skill.yaml", skill_dir / "skill.yml"]
    for source in yaml_sources:
        if source.exists():
            return _yaml_load(source.read_text(encoding="utf-8"))

    skill_md = skill_dir / "SKILL.md"
    if not skill_md.exists():
        return {}

    frontmatter = _extract_frontmatter(skill_md.read_text(encoding="utf-8"))
    if not frontmatter:
        return {}
    return _yaml_load(frontmatter)


class SkillRecord(Record):
    """A skill record backed by Record."""

    _record_type: ClassVar[str] = RecordType.SKILL
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["description"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.SKILL)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    @property
    def source_path(self) -> str:
        """Absolute path to the skill content folder (e.g. ~/.claude/skills/<name>/).

        Prefers asset_ref if set, then searches skill dirs by name, then falls back
        to the entity storage record_dir.
        """
        ar = self.asset_ref
        if ar is not None:
            return str(ar._path)
        skill_name = self.name
        if skill_name:
            for skills_dir in _skill_search_dirs():
                skill_dir = skills_dir / skill_name
                if skill_dir.is_dir():
                    return str(skill_dir)
        rd = self.record_dir
        return str(rd) if rd else ""

    # -- FSRef accessors --

    @property
    def main_ref(self) -> "Any":  # TextFsRef | None
        """Primary content ref: SKILL.md inside the skill folder."""
        from flow_sdk.fs_store.fs_ref import TextFsRef
        ar = self.asset_ref
        if ar is not None:
            return TextFsRef(ar._path / "SKILL.md")
        rd = self.record_dir
        if rd is not None:
            return TextFsRef(rd / "SKILL.md")
        return None

    @property
    def skill_doc(self) -> "Any":  # FSRef | None
        """FSRef pointing to SKILL.md inside the skill folder."""
        ar = self.asset_ref
        if ar is not None:
            return ar.child("SKILL.md")
        rd = self.record_dir
        if rd is not None:
            from flow_sdk.fs_store.fs_ref import FSRef
            return FSRef(rd / "SKILL.md")
        return None

    @property
    def skill_yaml(self) -> "Any":  # FSRef | None
        """FSRef pointing to skill.yaml or skill.yml inside the skill folder."""
        ar = self.asset_ref
        base_dir = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return None
        from flow_sdk.fs_store.fs_ref import FSRef
        for name in ("skill.yaml", "skill.yml"):
            ref = FSRef(base_dir / name)
            if ref.exists():
                return ref
        return None

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        desc = getattr(self, "description", None) or self.yaml_fields.get("description")
        if desc:
            parts.append(str(desc))
        doc = self.skill_doc
        if doc is not None and doc.exists():
            parts.append(doc.read())
        return "\n".join(parts) if parts else None

    def _fingerprint_paths(self):
        """Fingerprint the skill's own content files (SKILL.md + skill.yaml/yml)."""
        ar = self.asset_ref
        base_dir: Path | None = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return []
        paths = []
        for name in ("SKILL.md", "skill.yaml", "skill.yml"):
            p = base_dir / name
            if p.exists():
                paths.append(p)
        return paths

    @property
    def yaml_fields(self) -> dict[str, Any]:
        """Load YAML metadata from skill.yaml/skill.yml or SKILL.md frontmatter."""
        ar = self.asset_ref
        base_dir: Path | None = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return {}
        return _load_skill_yaml_from_dir(base_dir)

    def meta_dict(self) -> dict:
        result = super().meta_dict()
        sp = self.source_path
        if sp:
            result["source_path"] = sp
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
        """Read skill record -- bootstraps from YAML when JSON is absent."""
        if path.exists():
            super().read_record(path)
            return
        folder = path.parent
        if not folder.is_dir():
            return
        yaml_fields = _load_skill_yaml_from_dir(folder)
        yaml_name = yaml_fields.get("name")
        skill_name = (yaml_name.strip() if isinstance(yaml_name, str) and yaml_name.strip()
                      else folder.name.split("-@", 1)[-1] if "-@" in folder.name else folder.name)
        _d = object.__getattribute__(self, "__dict__")
        _d["id"] = skill_name
        _d["name"] = skill_name
        _d["type"] = RecordType.SKILL
        _d["status"] = "active"
        if isinstance(yaml_fields.get("description"), str):
            object.__setattr__(self, "description", yaml_fields["description"])
        if yaml_fields:
            object.__setattr__(self, "metadata", yaml_fields)

    @classmethod
    def load_record(cls, path: str | Path) -> "SkillRecord":
        """Load a skill record from a path, with YAML/frontmatter bootstrap for skill dirs."""
        from flow_sdk.fs_store.record import _META_JSON
        from flow_sdk.fs_store.fs_ref import FSRef

        p = Path(path)
        if not p.is_dir():
            return super().load_record(path)

        # Shadow record dir — load normally and set asset_ref to skill folder
        if (p / _META_JSON).exists() or (p / "data.json").exists():
            rec = super().load_record(path)
            object.__setattr__(rec, "_asset_ref", FSRef(p.resolve()))
            return rec

        # YAML/frontmatter bootstrap for live skill dirs
        yaml_fields = _load_skill_yaml_from_dir(p)
        yaml_name = yaml_fields.get("name")
        skill_name = (yaml_name.strip() if isinstance(yaml_name, str) and yaml_name.strip()
                      else p.name.split("-@", 1)[-1] if "-@" in p.name else p.name)

        data: dict[str, Any] = {"id": skill_name, "name": skill_name, "type": RecordType.SKILL, "status": "active"}
        if isinstance(yaml_fields.get("description"), str):
            data["description"] = yaml_fields["description"]
        if yaml_fields:
            data["metadata"] = yaml_fields
        rec = cls.from_dict(data)
        # _record_folder_ref stays None so save() targets records_root shadow.
        object.__setattr__(rec, "_asset_ref", FSRef(p.resolve()))
        return rec

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        """Count skill directories across all search dirs (fast, no YAML reads)."""
        seen: set[str] = set()
        for skills_dir in _skill_search_dirs():
            for entry in skills_dir.iterdir():
                if not entry.is_dir():
                    continue
                if not (entry / "SKILL.md").exists() and not (entry / "skill.yaml").exists():
                    continue
                seen.add(str(entry.resolve()))
        count = len(seen)
        return min(count, limit) if limit is not None else count

    @classmethod
    def discover_iter(cls, limit: int | None = None, scope: Scope | None = None, **kwargs: Any):
        """Lazy generator — yields one SkillRecord per skill directory."""
        from flow_sdk.fs_store.fs_ref import FSRef
        seen: set[str] = set()
        count = 0
        user_dir = (Path.home() / ".claude" / "skills").resolve()
        for skills_dir in _skill_search_dirs():
            is_user_dir = skills_dir.resolve() == user_dir
            rec_scope = Scope.USER if is_user_dir else Scope.PROJECT
            for entry in sorted(skills_dir.iterdir()):
                if not entry.is_dir():
                    continue
                if not (entry / "SKILL.md").exists() and not (entry / "skill.yaml").exists():
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
                    yield rec
                    count += 1
                    if limit is not None and count >= limit:
                        return
                except Exception:
                    continue

    @classmethod
    def _external_source_find_one(cls, uid: str) -> "SkillRecord | None":
        """Find a skill by its uuid5-derived ID from the .claude/skills directories."""
        for rec in cls.discover_iter():
            if rec.id == uid:
                return rec
        return None

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list["SkillRecord"]:
        """Discover all skill directories from user and project .claude/skills/ folders."""
        return list(cls.discover_iter(scope=scope, **kwargs))

    def copy_to_claude_user_home(self) -> Path:
        return self.copy_to(Path.home() / ".claude" / "skills")

    def copy_to_project(self, project_dir: str | Path) -> Path:
        return self.copy_to(Path(project_dir) / ".claude" / "skills")

    def copy_to(self, destination_root: Path) -> Path:
        ar = self.asset_ref
        source_dir: Path | None = ar._path if ar is not None else self.record_dir
        if source_dir is None:
            raise ValueError("Skill record has no source directory")
        if not (source_dir / "SKILL.md").exists():
            raise FileNotFoundError(f"Missing SKILL.md in {source_dir}")

        yaml_name = self.yaml_fields.get("name")
        skill_name = (yaml_name.strip() if isinstance(yaml_name, str) and yaml_name.strip()
                      else self.name or self.id or source_dir.name)

        destination_root.mkdir(parents=True, exist_ok=True)
        destination = destination_root / skill_name
        if destination.exists():
            shutil.rmtree(destination)
        shutil.copytree(source_dir, destination,
                        ignore=shutil.ignore_patterns(".flow_record", "record.json"))
        return destination

    def __getattr__(self, item: str) -> Any:
        # Check _data first (via parent), then yaml_fields
        try:
            return super().__getattr__(item)
        except AttributeError:
            pass
        yaml_data = object.__getattribute__(self, "yaml_fields")
        if item in yaml_data:
            return yaml_data[item]
        raise AttributeError(f"{self.__class__.__name__!s} has no attribute {item!r}")
