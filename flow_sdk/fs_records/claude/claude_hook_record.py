"""ClaudeHookRecord — individual Claude Code hook commands as fs_records.

Each record represents a single hook command entry extracted from the
``hooks`` section of ``settings.json`` files (user, project, local, plugin).

Hook JSON structure in settings.json::

    {
      "hooks": {
        "PreToolUse": [
          {
            "matcher": "Bash",
            "hooks": [
              {"type": "command", "command": "echo pre-tool"},
              {"type": "command", "command": "echo another"}
            ]
          }
        ]
      }
    }

Each inner ``{"type": "command", "command": "..."}`` becomes one
``ClaudeHookRecord``.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, ClassVar, Iterator

from flow_sdk.fs_store import Record, RecordType
from flow_sdk.fs_store.record_ref import RecordRef
from flow_sdk.fs_store.source_file_record_list import (
    _escape_json_pointer,
    _unescape_json_pointer,
)

if TYPE_CHECKING:
    from flow_sdk.fs_store.scope import Scope


def _set_pointer_with_arrays(data: dict, pointer: str, value: Any) -> None:
    """Set a value at an RFC 6901 JSON Pointer, handling list indices.

    Unlike ``_set_pointer`` in source_file_record_list, this correctly
    navigates list elements when the path segment is a numeric index.
    """
    if not pointer or pointer == "/":
        raise ValueError("Cannot set root pointer")
    parts = pointer.strip("/").split("/")
    current: Any = data
    for part in parts[:-1]:
        key = _unescape_json_pointer(part)
        if isinstance(current, list):
            idx = int(key)
            current = current[idx]
        else:
            if key not in current or not isinstance(current[key], (dict, list)):
                current[key] = {}
            current = current[key]
    leaf = _unescape_json_pointer(parts[-1])
    if isinstance(current, list):
        current[int(leaf)] = value
    else:
        current[leaf] = value


class ClaudeHookRecord(Record):
    """A single hook command entry from a settings.json file.

    Each record maps to one element in
    ``hooks.<event>[<group_idx>].hooks[<hook_idx>]``.

    Management fields (``plugin_name``, ``flowpad_hook_id``,
    ``flow_metadata_name``) are stored in ``_data`` alongside
    other domain fields.  This keeps the settings.json fragment clean —
    only ``{type, command}`` — and prevents external tools from
    deleting our metadata.

    The record ID is a stable 12-char hex hash of the file path + event
    type + matcher:command.  This survives array reordering after hook
    deletions.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_HOOK
    _indexed_by_default: ClassVar[bool] = True

    @property
    def search_title(self) -> str | None:
        event_type = getattr(self, "event_type", "") or ""
        matcher = getattr(self, "matcher", "") or "*"
        if event_type:
            return f"{event_type} ({matcher})" if matcher != "*" else event_type
        return self.name or None

    @property
    def search_content(self) -> str | None:
        return getattr(self, "command", None) or None

    def __init__(self, **kwargs: Any):
        # Drop legacy flow_metadata dict (extracted during discovery)
        kwargs.pop("flow_metadata", None)

        kwargs.setdefault("type", RecordType.CLAUDE_HOOK)
        kwargs.setdefault("event_type", "")
        kwargs.setdefault("matcher", "*")
        kwargs.setdefault("command", "")
        kwargs.setdefault("hook_type", "command")
        super().__init__(**kwargs)

    # -- Management field properties (read/write _data) --

    @property
    def plugin_name(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("plugin_name")

    @plugin_name.setter
    def plugin_name(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["plugin_name"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("plugin_name")

    @property
    def flowpad_hook_id(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("flowpad_hook_id")

    @flowpad_hook_id.setter
    def flowpad_hook_id(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["flowpad_hook_id"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("flowpad_hook_id")

    @property
    def flow_metadata_name(self) -> str | None:
        return object.__getattribute__(self, "__dict__").get("flow_metadata_name")

    @flow_metadata_name.setter
    def flow_metadata_name(self, value: str | None) -> None:
        object.__getattribute__(self, "__dict__")["flow_metadata_name"] = value
        dirty = object.__getattribute__(self, "_dirty_keys")
        dirty.add("flow_metadata_name")

    @classmethod
    def from_dict(cls, data: dict) -> ClaudeHookRecord:
        """Override to drop legacy flow_metadata field on deserialization."""
        data = dict(data)  # shallow copy to avoid mutating caller
        data.pop("flow_metadata", None)  # drop legacy field
        rec = super().from_dict(data)
        return rec

    @classmethod
    def getId(cls, ref) -> str:
        """File-level identifier for skip-fresh.

        CLAUDE_HOOK is 1:N — one settings.json produces many hook records,
        each with its own `_stable_hook_hash(source, event, matcher, command)`
        id set by `from_fsref`. At the asset level, the meaningful skip-fresh
        key is the source file: if the file hasn't changed, none of the hook
        records derived from it have changed either. This method returns
        that file-level identifier; individual record ids stay per-hook."""
        import uuid
        return str(uuid.uuid5(uuid.NAMESPACE_URL, f"hook_source:{ref._path.resolve()}"))

    @classmethod
    async def from_fsref(cls, ref) -> list["ClaudeHookRecord"]:
        """Indexer entry point — parse one settings-like file into N hook records.

        Dispatch on file shape:
          - installed_plugins.json: registry only, no hooks emitted (plugin
            cache `hooks.json` files are emitted separately by the walker).
          - plugin cache `hooks.json` (under ~/.claude/plugins/cache/...): apply
            $CLAUDE_PLUGIN_ROOT resolution and recompute stable id.
          - settings.json / settings.local.json / .claude.json: standard parse.
        """
        path = ref._path
        scope = ref.scope or "user"

        if path.name == "installed_plugins.json":
            return []

        # Plugin-cache hooks.json: ~/.claude/plugins/cache/<vendor>/<plugin>/<ver>/hooks/hooks.json
        if path.name == "hooks.json" and "plugins" in path.parts and "cache" in path.parts:
            install_path = str(path.parent.parent)  # `hooks/` -> install dir
            plugin_name = path.parent.parent.parent.name if len(path.parents) >= 4 else ""
            records = list(_parse_hooks_from_file(path, "plugin"))
            for rec in records:
                rec.command = _resolve_plugin_root(rec.command, install_path)
                rec.plugin_name = plugin_name
                rec.id = _stable_hook_hash(
                    str(path),
                    _escape_json_pointer(rec.event_type),
                    rec.matcher,
                    rec.command,
                )
            return records

        return list(_parse_hooks_from_file(path, scope))

    @classmethod
    def discover(
        cls,
        scope: Scope | None = None,
        search_paths: list[Path | str] | None = None,
        **kwargs: Any,
    ) -> list[ClaudeHookRecord]:
        """Discover all hook records from settings.json files.

        Args:
            scope: Optional scope filter (user/project/local).
            search_paths: Override directories to scan instead of defaults.
                          Each path should contain a ``settings.json`` file.
        """
        rl = ClaudeHookRecordList(search_paths=search_paths)
        records = list(rl)
        if scope is not None:
            scope_val = scope.value if hasattr(scope, "value") else str(scope)
            records = [r for r in records if _scope_str(r.scope) == scope_val]
        return records

    @classmethod
    def get(
        cls,
        uid: str,
        scope: Scope | None = None,
        search_paths: list[Path | str] | None = None,
        **kwargs: Any,
    ) -> ClaudeHookRecord | None:
        """Find a single hook record by id."""
        for r in cls.discover(scope=scope, search_paths=search_paths):
            if r.id == uid:
                return r
        return None

    def persist(self) -> None:
        """Write this hook entry back to its source settings.json file.

        Only domain fields (type, command) are written to settings.json.
        Management metadata is stored separately via save_meta_only().
        """
        if not self.source_file:
            raise ValueError("Cannot persist: no source_file set")
        if not self.event_type:
            raise ValueError("Cannot persist: no event_type set")

        source = Path(self.source_file)
        if source.exists():
            file_data = json.loads(source.read_text(encoding="utf-8"))
        else:
            file_data = {}

        # Only domain fields — no flow_metadata
        fragment: dict[str, Any] = {
            "type": self.hook_type,
            "command": self.command,
        }

        if self.json_path:
            # Update existing entry
            _set_pointer_with_arrays(file_data, self.json_path, fragment)
        else:
            # New record — append to event group
            hooks_section = file_data.setdefault("hooks", {})
            group_list = hooks_section.setdefault(self.event_type, [])

            # Find matching group or create new
            target_group = None
            group_idx = 0
            for idx, g in enumerate(group_list):
                if isinstance(g, dict) and g.get("matcher", "*") == self.matcher:
                    target_group = g
                    group_idx = idx
                    break
            if target_group is None:
                target_group = {"matcher": self.matcher, "hooks": []}
                group_list.append(target_group)
                group_idx = len(group_list) - 1

            target_group.setdefault("hooks", []).append(fragment)
            hook_idx = len(target_group["hooks"]) - 1

            escaped_event = _escape_json_pointer(self.event_type)
            self.json_path = f"/hooks/{escaped_event}/{group_idx}/hooks/{hook_idx}"
            object.__getattribute__(self, "__dict__")["id"] = _stable_hook_hash(
                str(source), escaped_event, self.matcher, self.command,
            )

        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    async def delete(self, delete_ref: bool = False) -> None:
        """Remove this hook entry from the source settings.json file."""
        if not self.source_file or not self.json_path:
            return

        source = Path(self.source_file)
        if not source.exists():
            return

        file_data = json.loads(source.read_text(encoding="utf-8"))

        parts = self.json_path.strip("/").split("/")
        if len(parts) != 5:
            return

        event_key = parts[1]
        group_idx = int(parts[2])
        hook_idx = int(parts[4])

        hooks_section = file_data.get("hooks", {})
        group_list = hooks_section.get(event_key)
        if not isinstance(group_list, list) or group_idx >= len(group_list):
            return

        group = group_list[group_idx]
        hook_entries = group.get("hooks", [])
        if not isinstance(hook_entries, list) or hook_idx >= len(hook_entries):
            return

        hook_entries.pop(hook_idx)
        if not hook_entries:
            group_list.pop(group_idx)
        if not group_list:
            del hooks_section[event_key]
        if not hooks_section:
            file_data.pop("hooks", None)

        source.write_text(
            json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )


def _scope_str(s: Any) -> str:
    return s.value if hasattr(s, "value") else str(s)


def _stable_hook_hash(
    file_path: str,
    escaped_event: str,
    matcher: str,
    command: str,
) -> str:
    """Stable UUID5 derived from file_path + event + matcher:command.

    Array-position-independent: survives reordering after hook deletions.
    Uses uuid5(NAMESPACE_DNS, key) so the result is a valid TypeId identifier.
    """
    import uuid
    key = f"{file_path}|/hooks/{escaped_event}|matcher:command|{matcher}:{command}"
    return str(uuid.uuid5(uuid.NAMESPACE_DNS, key))


def _merge_persisted_meta(rec: ClaudeHookRecord) -> None:
    """Load persisted data overlay and merge management fields.

    Called during discovery (step 4): if a record was previously saved,
    the overlay's management fields (and custom name)
    take precedence over values extracted from the source file.
    """
    from flow_sdk.fs_store.record import _DATA_JSON
    dp = rec.default_path
    if dp is None:
        return
    data_file = dp / _DATA_JSON
    if not data_file.exists():
        return
    try:
        raw = json.loads(data_file.read_text(encoding="utf-8"))
        persisted = raw.get("data", raw) if isinstance(raw, dict) else raw
    except (json.JSONDecodeError, OSError):
        return
    # Merge management fields — overlay wins
    for field in ("plugin_name", "flowpad_hook_id", "flow_metadata_name"):
        val = persisted.get(field)
        if val is not None:
            object.__setattr__(rec, field, val)
    # Custom name from overlay wins
    if persisted.get("name"):
        object.__setattr__(rec, "name", persisted["name"])


def _migrate_flow_metadata(records: list[ClaudeHookRecord]) -> None:
    """One-time migration: persist flow_metadata to overlay and strip from source.

    Called during discovery (step 5): for each record whose hook body in
    settings.json contains ``flow_metadata``, extract the management fields
    into the metadata overlay (via ``save_meta_only()``) and then remove
    ``flow_metadata`` / ``flowMetadata`` from the settings.json hook body.

    This is idempotent: once stripped, subsequent discoveries find no
    flow_metadata to migrate.
    """
    files_to_clean: dict[str, list[ClaudeHookRecord]] = {}

    for rec in records:
        if not getattr(rec, "_has_source_flow_metadata", False):
            continue

        sf = rec.source_file
        jp = getattr(rec, "json_path", "") or ""

        # Save data overlay — preserve source_file/path since
        # save() overwrites them as a side-effect.
        dp = rec.default_path
        if dp is not None:
            from flow_sdk.fs_store.record import _DATA_JSON
            data_file = dp / _DATA_JSON
            if not data_file.exists():
                orig_sf = rec.source_file
                orig_path = rec.path
                try:
                    rec.path = str(dp)
                    rec.save_record_json(data_file)
                except Exception:
                    continue
                finally:
                    rec.source_file = orig_sf
                    rec.path = orig_path

        if sf and jp:
            files_to_clean.setdefault(sf, []).append(rec)

    # Strip flow_metadata from source files
    for sf, recs in files_to_clean.items():
        source = Path(sf)
        if not source.exists():
            continue
        try:
            file_data = json.loads(source.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            continue

        modified = False
        for rec in recs:
            parts = rec.json_path.strip("/").split("/")
            if len(parts) != 5:
                continue
            try:
                current: Any = file_data
                for part in parts:
                    key = _unescape_json_pointer(part)
                    if isinstance(current, list):
                        current = current[int(key)]
                    else:
                        current = current[key]
                if isinstance(current, dict):
                    if "flow_metadata" in current:
                        del current["flow_metadata"]
                        modified = True
                    if "flowMetadata" in current:
                        del current["flowMetadata"]
                        modified = True
            except (KeyError, IndexError, TypeError, ValueError):
                continue

        if modified:
            source.write_text(
                json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )


def _resolve_plugin_root(command: str, install_path: str) -> str:
    """Replace $CLAUDE_PLUGIN_ROOT / ${CLAUDE_PLUGIN_ROOT} with the actual install path."""
    command = command.replace("${CLAUDE_PLUGIN_ROOT}", install_path)
    command = command.replace("$CLAUDE_PLUGIN_ROOT", install_path)
    return command


def _parse_hooks_from_plugins() -> list[ClaudeHookRecord]:
    """Extract hook records from installed Claude Code plugins.

    Reads the plugin registry at ``~/.claude/plugins/installed_plugins.json``
    and scans each plugin's ``hooks/hooks.json`` file.
    """
    claude_home = Path.home() / ".claude"
    registry_path = claude_home / "plugins" / "installed_plugins.json"
    if not registry_path.exists():
        return []

    try:
        registry = json.loads(registry_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    if not isinstance(registry, dict):
        return []

    plugins_map = registry.get("plugins", {})
    if not isinstance(plugins_map, dict):
        return []

    records: list[ClaudeHookRecord] = []
    for plugin_key, entries in plugins_map.items():
        plugin_name = plugin_key.split("@")[0] if "@" in plugin_key else plugin_key
        if not isinstance(entries, list):
            continue

        for plugin_entry in entries:
            install_path = plugin_entry.get("installPath", "")
            if not install_path:
                continue

            hooks_file = Path(install_path) / "hooks" / "hooks.json"
            raw = _parse_hooks_from_file(hooks_file, "plugin")
            for rec in raw:
                # Resolve $CLAUDE_PLUGIN_ROOT in command
                resolved_cmd = _resolve_plugin_root(rec.command, install_path)
                rec.command = resolved_cmd
                rec.plugin_name = plugin_name
                # Recompute hash with resolved command for stable ID
                escaped_event = _escape_json_pointer(rec.event_type)
                rec.id = _stable_hook_hash(
                    str(hooks_file), escaped_event, rec.matcher, resolved_cmd,
                )
            records.extend(raw)

    return records


def _parse_hooks_from_file(
    file_path: Path,
    scope: str,
) -> list[ClaudeHookRecord]:
    """Extract flat hook records from one settings JSON file."""
    if not file_path.exists():
        return []

    try:
        data = json.loads(file_path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return []

    hooks_section = data.get("hooks")
    if not hooks_section or not isinstance(hooks_section, dict):
        return []

    sf = str(file_path)
    records: list[ClaudeHookRecord] = []
    parent_ref = RecordRef(path=sf)

    for event_type, group_list in hooks_section.items():
        if not isinstance(group_list, list):
            continue
        escaped_event = _escape_json_pointer(event_type)

        for group_idx, group in enumerate(group_list):
            if not isinstance(group, dict):
                continue
            matcher = group.get("matcher", "*")
            hook_entries = group.get("hooks", [])
            if not isinstance(hook_entries, list):
                continue

            for hook_idx, h in enumerate(hook_entries):
                if not isinstance(h, dict):
                    continue

                command = h.get("command", "")
                hook_type = h.get("type", "command")

                # Extract flow_metadata from hook body (legacy migration)
                fm = h.get("flow_metadata") or h.get("flowMetadata")
                flow_metadata_name = None
                flowpad_hook_id = None

                if fm and isinstance(fm, dict):
                    flow_metadata_name = fm.get("name")
                    flowpad_hook_id = fm.get("flowpad_hook_id") or fm.get("flowpadHookId")

                # Detect sniffer hooks by command pattern (settings.json
                # won't contain flow_metadata since Claude Code strips it).
                if not flow_metadata_name and "--name=flowpad_sniffer" in command:
                    flow_metadata_name = "flowpad_sniffer"
                    m = re.search(r"--hook-entry-id=([^\s]+)", command)
                    if m and not flowpad_hook_id:
                        flowpad_hook_id = m.group(1)

                json_path = f"/hooks/{escaped_event}/{group_idx}/hooks/{hook_idx}"

                name = flow_metadata_name or f"{event_type} ({matcher})"

                rec = ClaudeHookRecord(
                    event_type=event_type,
                    matcher=matcher,
                    command=command,
                    hook_type=hook_type,
                    flowpad_hook_id=flowpad_hook_id,
                    flow_metadata_name=flow_metadata_name,
                )
                rec.id = _stable_hook_hash(sf, escaped_event, matcher, command)
                rec.name = name
                rec.scope = scope
                rec.source_file = sf
                rec.json_path = json_path
                rec.parent_ref = parent_ref
                # Flag for one-time flow_metadata migration (step 5)
                rec._has_source_flow_metadata = bool(fm and isinstance(fm, dict))

                records.append(rec)

    return records


def _default_search_paths() -> list[tuple[Path, str]]:
    """Return (directory, scope) pairs for default hook discovery.

    Mirrors the paths used by config_collector.get_all_hooks().
    """
    home = Path.home()
    claude_home = home / ".claude"
    paths: list[tuple[Path, str]] = []

    # User-level
    paths.append((claude_home, "user"))

    # Legacy (~/.claude.json) and plugins are handled directly in _discover()

    # Project-level: scan all projects
    projects_dir = claude_home / "projects"
    if projects_dir.is_dir():
        for project_dir in projects_dir.iterdir():
            if not project_dir.is_dir():
                continue
            # Read session files to find cwd
            try:
                from flow_sdk.core.resource_management.scan.system_profile._collectors.project_collector import (
                    get_project_cwd,
                )
                cwd = get_project_cwd(project_dir)
            except Exception:
                cwd = None
            if cwd:
                project_path = Path(cwd)
                if project_path.exists():
                    paths.append((project_path / ".claude", "project"))

    return paths


@dataclass
class ClaudeHookRecordList:
    """Discovers hook records from multiple settings.json files.

    Unlike JsonFileRecordStore (single file), this aggregates across
    user, project, and local settings files.
    """

    search_paths: list[Path | str] | None = None
    _cache: list[ClaudeHookRecord] | None = field(default=None, repr=False, init=False)

    def _discover(self) -> list[ClaudeHookRecord]:
        """Scan all settings files and extract hook records."""
        records: list[ClaudeHookRecord] = []
        seen_files: set[str] = set()

        if self.search_paths is not None:
            dirs_and_scopes: list[tuple[Path, str]] = [
                (Path(p), "user") for p in self.search_paths
            ]
        else:
            dirs_and_scopes = _default_search_paths()

        for folder, scope in dirs_and_scopes:
            for filename in ("settings.json", "settings.local.json"):
                settings_path = folder / filename
                if not settings_path.exists():
                    continue
                resolved = str(settings_path.resolve())
                if resolved in seen_files:
                    continue
                seen_files.add(resolved)

                file_scope = "local" if "local" in filename else scope
                records.extend(_parse_hooks_from_file(settings_path, file_scope))

        # Only scan plugins and legacy when using default paths
        if self.search_paths is None:
            # Plugins
            records.extend(_parse_hooks_from_plugins())

            # Legacy ~/.claude.json
            legacy_path = Path.home() / ".claude.json"
            if legacy_path.exists():
                resolved = str(legacy_path.resolve())
                if resolved not in seen_files:
                    seen_files.add(resolved)
                    records.extend(_parse_hooks_from_file(legacy_path, "legacy"))

        # Dedup by id (first occurrence wins, matching _merge_items behavior)
        seen_ids: set[str] = set()
        deduped: list[ClaudeHookRecord] = []
        for r in records:
            if r.id not in seen_ids:
                seen_ids.add(r.id)
                deduped.append(r)

        # Step 4: Merge persisted data overlays
        for rec in deduped:
            dp = rec.default_path
            if dp is not None and (dp / "data.json").exists():
                _merge_persisted_meta(rec)

        # Step 5: Migrate flow_metadata from source to overlay
        _migrate_flow_metadata(deduped)

        return deduped

    def _ensure_cache(self) -> list[ClaudeHookRecord]:
        if self._cache is None:
            self._cache = self._discover()
        return self._cache

    def reload(self) -> None:
        """Invalidate cache and re-read from disk."""
        self._cache = None

    def __iter__(self) -> Iterator[ClaudeHookRecord]:
        return iter(self._ensure_cache())

    def __len__(self) -> int:
        return len(self._ensure_cache())

    @property
    def records(self) -> list[ClaudeHookRecord]:
        return list(self._ensure_cache())

    def get(self, uid: str) -> ClaudeHookRecord | None:
        """Find a record by id."""
        for r in self._ensure_cache():
            if r.id == uid:
                return r
        return None

    def update(self, uid: str, data: dict[str, Any]) -> ClaudeHookRecord:
        """Update a hook record's fields and write back to its source file."""
        record = self.get(uid)
        if record is None:
            raise KeyError(f"No hook record with uid={uid!r}")

        for key, value in data.items():
            setattr(record, key, value)

        self._write_record_to_source(record)
        return record

    def delete_record(self, uid: str) -> bool:
        """Remove a hook entry from the source file."""
        record = self.get(uid)
        if record is None:
            return False
        if not record.source_file or not record.json_path:
            return False

        source = Path(record.source_file)
        if not source.exists():
            return False

        file_data = json.loads(source.read_text(encoding="utf-8"))

        parts = record.json_path.strip("/").split("/")
        if len(parts) != 5:
            return False

        event_key = parts[1]
        group_idx = int(parts[2])
        hook_idx = int(parts[4])

        hooks_section = file_data.get("hooks", {})
        group_list = hooks_section.get(event_key)
        if not isinstance(group_list, list) or group_idx >= len(group_list):
            return False

        group = group_list[group_idx]
        hook_entries = group.get("hooks", [])
        if not isinstance(hook_entries, list) or hook_idx >= len(hook_entries):
            return False

        hook_entries.pop(hook_idx)
        if not hook_entries:
            group_list.pop(group_idx)
        if not group_list:
            del hooks_section[event_key]
        if not hooks_section:
            del file_data["hooks"]

        source.write_text(
            json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self.reload()
        return True

    def create(self, data: dict[str, Any]) -> ClaudeHookRecord:
        """Create a new hook entry in the source file.

        Requires ``source_file`` and ``event_type`` in *data*.
        """
        source_file = data.get("source_file")
        event_type = data.get("event_type")
        if not source_file or not event_type:
            raise ValueError("source_file and event_type are required")

        source = Path(source_file)
        if source.exists():
            file_data = json.loads(source.read_text(encoding="utf-8"))
        else:
            file_data = {}

        matcher = data.get("matcher", "*")
        command = data.get("command", "")
        hook_type = data.get("hook_type", "command")

        # Only domain fields — no flow_metadata
        hook_body: dict[str, Any] = {"type": hook_type, "command": command}

        hooks_section = file_data.setdefault("hooks", {})
        group_list = hooks_section.setdefault(event_type, [])

        target_group = None
        group_idx = 0
        for idx, g in enumerate(group_list):
            if isinstance(g, dict) and g.get("matcher", "*") == matcher:
                target_group = g
                group_idx = idx
                break

        if target_group is None:
            target_group = {"matcher": matcher, "hooks": []}
            group_list.append(target_group)
            group_idx = len(group_list) - 1

        target_group.setdefault("hooks", []).append(hook_body)
        hook_idx = len(target_group["hooks"]) - 1

        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

        scope = data.get("scope", "user")
        escaped_event = _escape_json_pointer(event_type)
        json_path = f"/hooks/{escaped_event}/{group_idx}/hooks/{hook_idx}"
        rec = ClaudeHookRecord(
            event_type=event_type,
            matcher=matcher,
            command=command,
            hook_type=hook_type,
        )
        rec.id = _stable_hook_hash(str(source), escaped_event, matcher, command)
        rec.name = data.get("name", f"{event_type} ({matcher})")
        rec.scope = scope
        rec.source_file = str(source)
        rec.json_path = json_path
        rec.parent_ref = RecordRef(path=str(source))

        self.reload()
        return rec

    def _write_record_to_source(self, record: ClaudeHookRecord) -> None:
        """Serialize one hook record back into its source file."""
        if not record.source_file or not record.json_path:
            raise ValueError("Cannot write: record has no source_file or json_path")

        source = Path(record.source_file)
        if source.exists():
            file_data = json.loads(source.read_text(encoding="utf-8"))
        else:
            file_data = {}

        # Only domain fields — no flow_metadata
        fragment: dict[str, Any] = {
            "type": record.hook_type,
            "command": record.command,
        }

        _set_pointer_with_arrays(file_data, record.json_path, fragment)

        source.parent.mkdir(parents=True, exist_ok=True)
        source.write_text(
            json.dumps(file_data, indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )
        self.reload()
