"""SkillitSkill -- a typed record for skills managed by skillit."""

from __future__ import annotations

import shutil
import uuid
from pathlib import Path
from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record import Scope
from flow_sdk.instance_settings import get_instance_settings

from ._frontmatter import (  # noqa: F401
    _coerce_scalar,
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)


def _read_frontmatter_id_from_yaml(yaml_fields: dict) -> str | None:
    """Pick `id` (or legacy `asset_id`) from a parsed yaml/frontmatter dict."""
    raw = yaml_fields.get("id") or yaml_fields.get("asset_id")
    return str(raw).strip() if isinstance(raw, str) and raw.strip() else None


def _resolve_skill_name(yaml_fields: dict, folder_name: str) -> str:
    """Pick the skill's display name: yaml.name first, else folder name (stripping
    a leading shadow-record `<type>-@` prefix if present)."""
    yaml_name = yaml_fields.get("name")
    if isinstance(yaml_name, str) and yaml_name.strip():
        return yaml_name.strip()
    return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name


def _skill_id_from_name(name: str) -> str:
    """Stable uuid5 derived from the skill name. Names like 'Byte Stats Skill' contain
    spaces and other characters that would fail TypeId validation if used as a raw id."""
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, f"{RecordType.SKILL}:{name}"))


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

    _add(get_instance_settings().claude_skills_dir)

    # SDK-shipped system skills under the Flowpad Assistant system project.
    try:
        from flow_sdk.config import flowpad_assistant_project_root
        _add(flowpad_assistant_project_root() / ".claude" / "skills")
    except Exception:
        pass

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
    _browseable: ClassVar[bool] = True
    _creatable: ClassVar[bool] = True
    _icon: ClassVar[str] = "Sparkles"
    index_fields: ClassVar[list[str]] = ["description"]

    # Framework upsert: <scope_root>/.claude/skills/<safe_name>/SKILL.md
    _main_subdir: ClassVar[str] = ".claude/skills"
    _main_layout: ClassVar[str] = "folder"

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.SKILL)
        kwargs.setdefault("status", "active")
        super().__init__(**kwargs)

    def default_body(self, entity) -> "str | None":
        """YAML stub for new skills. Only invoked by upsert_main_ref when
        SKILL.md doesn't yet exist at the asset_ref folder. Shadow guard in
        Record.upsert_main_ref refuses writes inside the shadow tree."""
        name = (getattr(entity, "name", None) or "").strip()
        if not name:
            return None
        desc = (getattr(entity, "description", None) or "").strip()
        return f'---\nid: {entity.id}\nname: {name}\ndescription: "{desc}"\n---\n\n# {name}\n\n'

    # -- FSRef accessors --

    @property
    def skill_doc(self) -> "Any":  # FrontMatterFsRef | None
        """FrontMatterFsRef pointing to SKILL.md inside the skill folder at asset_ref."""
        from flow_sdk.fs_store.fs_ref import FrontMatterFsRef
        ar = self.asset_ref
        if ar is None:
            return None
        return FrontMatterFsRef(ar._path / "SKILL.md")

    @property
    def main_ref(self) -> "Any":  # FrontMatterFsRef | None
        """Primary content ref: delegates to skill_doc."""
        return self.skill_doc

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

    def wiki_body(self) -> str | None:
        """Read the SKILL.md body for wiki link extraction."""
        doc = self.skill_doc
        if doc is None or not doc.exists():
            return None
        try:
            return doc.read_body()
        except Exception:
            return None

    def _asset_paths(self):
        """Skill assets are the inner content files — dir mtime won't catch edits to these."""
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

    @classmethod
    def asset_hash_for_ref(cls, ref) -> float:
        """Skill folder — stat inner content files, since dir mtime doesn't
        update when a child's content is edited."""
        base = ref._path
        ts = 0.0
        for name in ("SKILL.md", "skill.yaml", "skill.yml"):
            try:
                ts = max(ts, (base / name).stat().st_mtime)
            except OSError:
                pass
        return ts

    @property
    def yaml_fields(self) -> dict[str, Any]:
        """Load YAML metadata from skill.yaml/skill.yml or SKILL.md frontmatter."""
        ar = self.asset_ref
        base_dir: Path | None = ar._path if ar is not None else self.record_dir
        if base_dir is None:
            return {}
        # Prefer skill.yaml / skill.yml (existing priority)
        for name in ("skill.yaml", "skill.yml"):
            p = base_dir / name
            if p.exists():
                return _load_skill_yaml_from_dir(base_dir)
        # Fall back to SKILL.md frontmatter via skill_doc
        doc = self.skill_doc
        if doc is not None:
            return doc.read_frontmatter()
        return {}

    def meta_dict(self) -> dict:
        # Keep asset-mtime as updated_date so FTS sees the freshest timestamp —
        # base asset_ref injection is handled by Record.meta_dict.
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
        """Read skill record -- bootstraps from YAML when JSON is absent."""
        if path.exists():
            super().read_record(path)
            return
        folder = path.parent
        if not folder.is_dir():
            return
        yaml_fields = _load_skill_yaml_from_dir(folder)
        skill_name = _resolve_skill_name(yaml_fields, folder.name)
        _d = object.__getattribute__(self, "__dict__")
        # Prefer frontmatter `id` (or legacy `asset_id`) over name-derivation.
        _d["id"] = _read_frontmatter_id_from_yaml(yaml_fields) or _skill_id_from_name(skill_name)
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

        # Shadow record dir — load normally. asset_ref MUST come from
        # metadata.json["asset_ref"]; never overwrite with the shadow path.
        if (p / _META_JSON).exists() or (p / "data.json").exists():
            return super().load_record(path)

        # YAML/frontmatter bootstrap for live skill dirs
        yaml_fields = _load_skill_yaml_from_dir(p)
        skill_name = _resolve_skill_name(yaml_fields, p.name)

        data: dict[str, Any] = {
            # Prefer frontmatter `id` (or legacy `asset_id`); fall back to
            # name-derivation for skills that haven't been stamped yet.
            "id": _read_frontmatter_id_from_yaml(yaml_fields) or _skill_id_from_name(skill_name),
            "name": skill_name,
            "type": RecordType.SKILL,
            "status": "active",
        }
        if isinstance(yaml_fields.get("description"), str):
            data["description"] = yaml_fields["description"]
        if yaml_fields:
            data["metadata"] = yaml_fields
        rec = cls.from_dict(data)
        # _record_folder_ref stays None so save() targets records_root shadow.
        object.__setattr__(rec, "_asset_ref", FSRef(p.resolve()))
        return rec

    @classmethod
    def _from_fsref_sync(cls, ref) -> list["SkillRecord"]:
        """Indexer entry point — construct from an FSRef emitted by skill_fn."""
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

        Prefer frontmatter ``id`` (or legacy ``asset_id``) when present in
        skill.yaml / skill.yml / SKILL.md — that's the stable, file-bound id.
        Otherwise fall back to ``load_record`` semantics (uuid5 of the skill
        name for live dirs, or metadata.json blob for shadow dirs).
        """
        try:
            if ref._path.is_dir():
                yaml_fields = _load_skill_yaml_from_dir(ref._path)
                fm_id = _read_frontmatter_id_from_yaml(yaml_fields)
                if fm_id:
                    return fm_id
            rec = cls.load_record(ref._path)
            return str(rec.id)
        except Exception:
            folder_name = ref._path.name
            return folder_name.split("-@", 1)[-1] if "-@" in folder_name else folder_name

    @classmethod
    def genId(cls, ref) -> str:
        """Read existing id, or mint+write a stable one into SKILL.md frontmatter.

        Idempotent. For yaml-based skills (skill.yaml / skill.yml present), we
        skip the write and just return the derived id — touching arbitrary yaml
        files belongs to a separate change. For SKILL.md-only skills, the
        currently derived id (``_skill_id_from_name(name)``) is written into
        the frontmatter so future scans return the same id even if the yaml
        ``name`` changes or the folder is renamed.
        """
        if not ref._path.is_dir():
            return cls.getId(ref)
        yaml_fields = _load_skill_yaml_from_dir(ref._path)
        existing = _read_frontmatter_id_from_yaml(yaml_fields)
        if existing:
            return existing
        skill_name = _resolve_skill_name(yaml_fields, ref._path.name)
        new_id = _skill_id_from_name(skill_name)
        # skill.yaml-based skills: don't touch the yaml file in this iteration.
        if (ref._path / "skill.yaml").exists() or (ref._path / "skill.yml").exists():
            return new_id
        skill_md = ref._path / "SKILL.md"
        if not skill_md.exists():
            return new_id
        try:
            text = skill_md.read_text(encoding="utf-8")
        except OSError:
            return new_id
        fm = _extract_frontmatter(text)
        body = _extract_body(text)
        fields: dict = {}
        if fm:
            parsed = _yaml_load(fm)
            if isinstance(parsed, dict):
                fields.update(parsed)
        merged = {"id": new_id, **{k: v for k, v in fields.items() if k not in ("id", "asset_id")}}
        try:
            skill_md.write_text(
                _render_frontmatter(merged) + "\n\n" + body + ("\n" if body and not body.endswith("\n") else ""),
                encoding="utf-8",
            )
        except OSError:
            pass
        return new_id

    @classmethod
    def get(cls, uid: str, **kwargs: Any) -> "SkillRecord | None":
        """Find a skill by uid: records_root first, then the .claude/skills directories."""
        rec = super().get(uid, **kwargs)
        if rec is not None:
            return rec
        for rec in cls.discover():
            if rec.id == uid:
                return rec
        return None

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list["SkillRecord"]:
        """Discover all skill directories from user and project .claude/skills/ folders."""
        from flow_sdk.fs_store.fs_ref import FSRef
        results: list[SkillRecord] = []
        seen: set[str] = set()
        user_dir = (get_instance_settings().claude_skills_dir).resolve()
        limit = kwargs.get("limit")
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
                    results.append(rec)
                    if limit is not None and len(results) >= limit:
                        return results
                except Exception:
                    continue
        return results

    def copy_to_claude_user_home(self) -> Path:
        return self.copy_to(get_instance_settings().claude_skills_dir)

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
