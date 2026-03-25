"""AgentRecord -- a typed record for Claude Code sub-agents.

Stores agent definitions in a folder layout::

    agent-@my-agent/
      .flow_record/record.json   # meta + structured data fields
      my-agent.md                # YAML frontmatter + system prompt body

The ``prompt`` property reads/writes the markdown body from the companion
``.md`` file.  All other Claude Code ``--agents`` spec fields live on
``_data`` and round-trip through ``to_agents_json`` / ``from_agents_json``.
"""

from __future__ import annotations

from pathlib import Path
from typing import Any, ClassVar
from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record import Scope


def _agent_search_dirs() -> list[Path]:
    """Return directories to scan for agent .md files.

    Scans user-level (~/.claude/agents) and the cwd/.claude/agents if present
    (covers project-level agents when the server runs from the project dir).
    """
    import os
    dirs: list[Path] = []
    seen: set[Path] = set()

    def _add(p: Path) -> None:
        rp = p.resolve()
        if rp not in seen and rp.is_dir():
            seen.add(rp)
            dirs.append(p)

    _add(Path.home() / ".claude" / "agents")
    _add(Path(os.getcwd()) / ".claude" / "agents")

    for extra in os.environ.get("FLOWPAD_AGENT_DIRS", "").split(":"):
        if extra.strip():
            _add(Path(extra.strip()))

    return dirs

from ._frontmatter import (
    _extract_body,
    _extract_frontmatter,
    _render_frontmatter,
    _yaml_load,
)

# Fields stored in _data that map to the Claude Code --agents JSON spec
_AGENTS_SPEC_FIELDS = (
    "description",
    "tools",
    "disallowed_tools",
    "model",
    "color",
    "permission_mode",
    "max_turns",
    "skills",
    "mcp_servers",
    "hooks",
    "memory",
    "background",
    "isolation",
)

# Mapping from snake_case _data keys to camelCase --agents JSON keys
_KEY_TO_JSON = {
    "disallowed_tools": "disallowedTools",
    "permission_mode": "permissionMode",
    "max_turns": "maxTurns",
    "mcp_servers": "mcpServers",
}
_JSON_TO_KEY = {v: k for k, v in _KEY_TO_JSON.items()}


class AgentRecord(Record):
    """A first-class record type for Claude Code sub-agents."""

    _record_type: ClassVar[str] = RecordType.AGENT
    _indexed_by_default: ClassVar[bool] = True
    _user_asset: ClassVar[bool] = True
    index_fields: ClassVar[list[str]] = ["description"]

    def __init__(self, **kwargs: Any):
        kwargs.setdefault("type", RecordType.AGENT)
        kwargs.setdefault("status", "active")
        # Store prompt body as prompt_text (the backing attr used by the property getter)
        prompt_val = kwargs.pop("prompt", None)
        super().__init__(**kwargs)
        if prompt_val is not None:
            object.__getattribute__(self, "__dict__")["prompt_text"] = prompt_val

    @property
    def source_path(self) -> str:
        """Absolute path to the agent .md file on disk."""
        ar = self.asset_ref
        if ar is not None:
            return ar.path
        rd = self.record_dir
        if rd is not None and self.name:
            return str(rd / f"{self.name}.md")
        return ""

    @property
    def main_ref(self) -> "Any":  # FSRef | None
        """Primary content ref: the agent's .md file."""
        ar = self.asset_ref
        if ar is not None:
            return ar
        rd = self.record_dir
        if rd is None or not self.name:
            return None
        from flow_sdk.fs_store.fs_ref import TextFsRef
        return TextFsRef(rd / f"{self.name}.md")

    def meta_dict(self) -> dict:
        result = super().meta_dict()
        try:
            import os as _os
            from datetime import datetime as _dt, timezone as _tz
            ar = self.asset_ref
            if ar is not None:
                p = ar._path
                result["updated_date"] = _dt.fromtimestamp(_os.path.getmtime(p), tz=_tz.utc).isoformat()
        except Exception:
            pass
        return result

    @property
    def search_content(self) -> str | None:
        parts: list[str] = []
        if self.name:
            parts.append(self.name)
        desc = getattr(self, "description", None)
        if desc:
            parts.append(str(desc))
        prompt_text = self.prompt
        if prompt_text:
            parts.append(prompt_text)
        return "\n".join(parts) if parts else None

    # -- Prompt (stored in companion .md file, not _data) -------------------

    @property
    def prompt(self) -> str:
        """Read the system prompt from the companion markdown file."""
        md_name = f"{self.name}.md" if self.name else None
        if md_name:
            content = self.read_file(md_name)
            if content is not None:
                return _extract_body(content)
        return getattr(self, "prompt_text", "") or ""

    @prompt.setter
    def prompt(self, value: str) -> None:
        md_name = f"{self.name}.md" if self.name else None
        if md_name and self.record_dir is not None:
            self.write_file(md_name, self._render_markdown(body=value))
        else:
            object.__setattr__(self, "prompt_text", value)
            dirty = object.__getattribute__(self, "_dirty_keys")
            dirty.add("prompt_text")

    # -- Markdown serialization --------------------------------------------

    def _frontmatter_fields(self) -> dict[str, Any]:
        """Collect fields for YAML frontmatter (everything except prompt)."""
        fields: dict[str, Any] = {}
        if self.name:
            fields["name"] = self.name
        for key in _AGENTS_SPEC_FIELDS:
            val = getattr(self, key, None)
            if val is not None:
                fields[key] = val
        return fields

    def _render_markdown(self, body: str | None = None) -> str:
        """Render YAML frontmatter + body into a complete markdown string."""
        fm = _render_frontmatter(self._frontmatter_fields())
        body_text = body if body is not None else self.prompt
        if body_text:
            return f"{fm}\n\n{body_text}\n"
        return f"{fm}\n"

    def to_markdown(self) -> str:
        """Full markdown representation (frontmatter + prompt body)."""
        return self._render_markdown()

    @classmethod
    def from_markdown(cls, text: str, name: str | None = None) -> AgentRecord:
        """Parse a markdown string with YAML frontmatter into an AgentRecord."""
        fm_text = _extract_frontmatter(text)
        fields = _yaml_load(fm_text) if fm_text else {}
        body = _extract_body(text)

        agent_name = name or fields.pop("name", None) or "unnamed"
        data: dict[str, Any] = {"id": agent_name, "name": agent_name}
        for key in _AGENTS_SPEC_FIELDS:
            if key in fields:
                data[key] = fields[key]
        if body:
            data["prompt"] = body

        return cls(**data)

    @classmethod
    def _external_source_find_one(cls, uid: str) -> "AgentRecord | None":
        """Find an agent by name/id: checks user dirs then system assets."""
        for agents_dir in _agent_search_dirs():
            md = agents_dir / f"{uid}.md"
            if md.exists():
                return cls.from_file(md)
        return cls.load_system_agent(uid)

    @classmethod
    def from_file(cls, path: str | Path) -> AgentRecord:
        """Load an AgentRecord from a standalone ``.md`` file.

        Unlike ``load_from_dir`` (which expects a directory with ``.flow_record/``),
        this reads a single markdown file and creates an in-memory AgentRecord.
        """
        p = Path(path)
        text = p.read_text(encoding="utf-8")
        rec = cls.from_markdown(text, name=p.stem)
        from flow_sdk.fs_store.fs_ref import FSRef
        rec.asset_ref = FSRef(p)
        return rec

    # -- Claude Code --agents JSON -----------------------------------------

    def to_agents_json(self) -> dict[str, dict[str, Any]]:
        """Build ``{name: {description, prompt, ...}}`` dict for ``--agents`` flag."""
        entry: dict[str, Any] = {}
        # prompt always included
        prompt = self.prompt
        if prompt:
            entry["prompt"] = prompt
        for key in _AGENTS_SPEC_FIELDS:
            val = self.data.get(key)
            if val is not None:
                json_key = _KEY_TO_JSON.get(key, key)
                entry[json_key] = val
        return {self.name or self.id: entry}

    @classmethod
    def from_agents_json(cls, name: str, data: dict[str, Any]) -> AgentRecord:
        """Create an AgentRecord from a single entry in ``--agents`` JSON."""
        kwargs: dict[str, Any] = {"id": name, "name": name}
        for json_key, val in data.items():
            data_key = _JSON_TO_KEY.get(json_key, json_key)
            kwargs[data_key] = val
        return cls(**kwargs)

    # -- Disk I/O overrides ------------------------------------------------

    def read_record(self, path: Path) -> None:
        """Read agent record; bootstraps from .md when record.json is absent."""
        if path.exists():
            super().read_record(path)
            return
        # Bootstrap from companion markdown
        folder = path.parent
        if not folder.is_dir():
            return
        md_files = list(folder.glob("*.md"))
        if not md_files:
            return
        md_file = md_files[0]
        text = md_file.read_text(encoding="utf-8")
        fm_text = _extract_frontmatter(text)
        fields = _yaml_load(fm_text) if fm_text else {}
        body = _extract_body(text)

        agent_name = fields.get("name") or md_file.stem
        if isinstance(agent_name, str):
            agent_name = agent_name.strip()
        else:
            agent_name = folder.name.split("-@", 1)[-1] if "-@" in folder.name else folder.name

        _d = object.__getattribute__(self, "__dict__")
        _d["id"] = agent_name
        _d["name"] = agent_name
        _d["type"] = RecordType.AGENT
        _d["status"] = "active"
        for key in _AGENTS_SPEC_FIELDS:
            if key in fields:
                object.__setattr__(self, key, fields[key])
        if body:
            object.__setattr__(self, "prompt_text", body)

    @classmethod
    def init_record(cls, path_or_data, path=None, indent=2) -> "AgentRecord":
        """Initialize or load an agent record with markdown bootstrap."""
        if isinstance(path_or_data, dict):
            return super().init_record(path_or_data, path, indent=indent)

        p = Path(path_or_data)
        if p.is_dir():
            if (p / "data.json").exists() or (p / "metadata.json").exists():
                return super().init_record(path_or_data, path, indent=indent)
        elif p.exists():
            return super().init_record(path_or_data, path, indent=indent)

        if not p.is_dir():
            return super().init_record(path_or_data, path, indent=indent)

        # Try markdown bootstrap
        md_files = list(p.glob("*.md"))
        if not md_files:
            return super().init_record(path_or_data, path, indent=indent)

        md_file = md_files[0]
        text = md_file.read_text(encoding="utf-8")
        fm_text = _extract_frontmatter(text)
        fields = _yaml_load(fm_text) if fm_text else {}
        body = _extract_body(text)

        agent_name = fields.get("name") or md_file.stem
        if isinstance(agent_name, str):
            agent_name = agent_name.strip()
        else:
            agent_name = p.name.split("-@", 1)[-1] if "-@" in p.name else p.name

        data: dict[str, Any] = {"id": agent_name, "name": agent_name, "type": RecordType.AGENT, "status": "active"}
        for key in _AGENTS_SPEC_FIELDS:
            if key in fields:
                data[key] = fields[key]
        rec = cls.from_dict(data)
        # Store prompt as prompt_text (the backing attr used by the property getter)
        if body:
            object.__getattribute__(rec, "__dict__")["prompt_text"] = body
        # Set asset_ref to the .md file (consistent with from_file); _record_folder_ref
        # stays None so save() uses metadata_ref → default_path → records_root shadow.
        from flow_sdk.fs_store.fs_ref import TextFsRef
        object.__setattr__(rec, "_asset_ref", TextFsRef(md_file.resolve()))
        return rec

    @classmethod
    def load_record(cls, path: str | Path) -> AgentRecord:
        return cls.init_record(path)

    def save(self) -> None:
        """Save both record.json and the companion .md file."""
        super().save()
        ar = self.asset_ref
        if ar is not None:
            ar.write(self._render_markdown())
        elif self.record_dir is not None and self.name:
            from flow_sdk.fs_store.fs_ref import FSRef
            FSRef(self.record_dir / f"{self.name}.md").write(self._render_markdown())

    # -- Loader helpers ----------------------------------------------------

    @classmethod
    def discovery_items_count(cls, limit: int | None = None) -> int:
        """Count agent .md files across all search dirs (fast, no file reads)."""
        seen: set[str] = set()
        for agents_dir in _agent_search_dirs():
            for f in agents_dir.glob("*.md"):
                seen.add(str(f.resolve()))
        count = len(seen)
        return min(count, limit) if limit is not None else count

    @classmethod
    def discover_iter(cls, limit: int | None = None, scope: Scope | None = None, **kwargs: Any):
        """Lazy generator — yields one AgentRecord per .md file."""
        seen: set[str] = set()
        count = 0
        for agents_dir in _agent_search_dirs():
            for f in sorted(agents_dir.glob("*.md")):
                key = str(f.resolve())
                if key in seen:
                    continue
                seen.add(key)
                try:
                    yield cls.from_file(f)
                    count += 1
                    if limit is not None and count >= limit:
                        return
                except Exception:
                    continue

    @classmethod
    def discover(cls, scope: Scope | None = None, **kwargs: Any) -> list["AgentRecord"]:
        """Discover all agent .md files from user and project .claude/agents/ folders."""
        return list(cls.discover_iter(scope=scope, **kwargs))

    @staticmethod
    def load_from_dir(agent_dir: Path) -> AgentRecord | None:
        """Load an AgentRecord from a directory, bootstrapping from .md if needed."""
        if not agent_dir.is_dir():
            return None
        return AgentRecord.init_record(agent_dir)

    @staticmethod
    def load_system_agent(name: str) -> AgentRecord | None:
        """Load from system_assets/agents/<name>/."""
        import flow_sdk

        source = Path(flow_sdk.__file__).parent / "system_assets" / "agents" / name
        if source.is_dir():
            return AgentRecord.load_from_dir(source)
        # Also check workspace
        workspace = Path.home() / "Flowpad workspace" / ".flow" / "system_assets" / "agents" / name
        if workspace.is_dir():
            return AgentRecord.load_from_dir(workspace)
        return None

    @staticmethod
    def load_agent(name: str, project_dir: str | Path | None = None) -> AgentRecord | None:
        """Load with priority: project > user > system."""
        # Project agents
        if project_dir is not None:
            p = Path(project_dir) / ".claude" / "agents" / name
            if p.is_dir():
                return AgentRecord.load_from_dir(p)

        # User agents
        user = Path.home() / ".claude" / "agents" / name
        if user.is_dir():
            return AgentRecord.load_from_dir(user)

        # System agents
        return AgentRecord.load_system_agent(name)

