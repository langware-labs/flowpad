"""HookFile class for managing hook configurations."""

from pathlib import Path
from typing import Optional

from flow_sdk.hooks.models import HookEntry, HookEntryResult
from flow_sdk.hooks.providers.claude_code import ClaudeCodeHookFile


class HookFile:
    """
    Manages hook configurations for a specific file.

    Stores a flat list of HookEntry objects.
    Uses ClaudeCodeHookFile for provider-specific serialization.
    """

    def __init__(self, path: Optional[Path], provider: ClaudeCodeHookFile):
        self.path = path
        self.provider = provider
        self._entries: list[HookEntry] = []

        if path and path.exists():
            self.load()

    def load(self) -> None:
        """Load hooks from file."""
        if self.path:
            self._entries = self.provider.read(self.path)

    def save(self) -> None:
        """Save hooks to file."""
        if self.path:
            self.provider.write(self.path, self._entries)

    def get_entries(self, event: Optional[str] = None) -> list[HookEntry]:
        """Get entries, optionally filtered by event."""
        if event is None:
            return list(self._entries)
        return [e for e in self._entries if e.event == event]

    def get_entry(self, entry_id: str) -> Optional[HookEntry]:
        """
        Get entry by ID, searching through all hooks in entries.

        First tries to match entry.id, then searches raw JSON for entries
        containing a hook with matching _flowpad_hook_id.
        """
        # First try the simple match (for entries where ID matches entry.id)
        for entry in self._entries:
            if entry.id == entry_id:
                return entry

        # If not found, search through raw JSON to find entry containing a hook with matching flow_metadata or legacy _flowpad_hook_id
        if self.path and self.path.exists():
            import json

            try:
                with open(self.path, "r") as f:
                    data = json.load(f)

                hooks_data = data.get("hooks", {})
                for event_name, event_entries in hooks_data.items():
                    if not isinstance(event_entries, list):
                        continue

                    for entry_data in event_entries:
                        hooks_list = entry_data.get("hooks", [])
                        # Search through all hooks in this entry
                        for hook in hooks_list:
                            if not isinstance(hook, dict):
                                continue
                            # Check flow_metadata.flowpad_hook_id first
                            fm = hook.get("flow_metadata")
                            if fm and isinstance(fm, dict) and fm.get("flowpad_hook_id") == entry_id:
                                if isinstance(self.provider, ClaudeCodeHookFile):
                                    parsed_entry = ClaudeCodeHookFile._parse_entry(event_name, entry_data)
                                    if parsed_entry:
                                        return parsed_entry
                            # Legacy fallback
                            if hook.get("_flowpad_hook_id") == entry_id:
                                if isinstance(self.provider, ClaudeCodeHookFile):
                                    parsed_entry = ClaudeCodeHookFile._parse_entry(event_name, entry_data)
                                    if parsed_entry:
                                        return parsed_entry
            except (json.JSONDecodeError, OSError):
                pass

        return None

    def add_entry(self, entry: HookEntry) -> None:
        """Add a hook entry."""
        self._entries.append(entry)

    def remove_entry(self, entry_id: str) -> bool:
        """
        Remove entry by ID, searching through all hooks in entries.

        First tries to match entry.id, then searches raw JSON for entries
        containing a hook with matching _flowpad_hook_id.
        """
        # First try the simple match (for entries where ID matches entry.id)
        for i, entry in enumerate(self._entries):
            if entry.id == entry_id:
                self._entries.pop(i)
                return True

        # If not found in cached entries, search through raw JSON
        if self.path and self.path.exists():
            import json

            def _matches_hook_id(hook: dict, eid: str) -> bool:
                """Check if a hook dict matches the given entry ID via flow_metadata or legacy marker."""
                fm = hook.get("flow_metadata")
                if fm and isinstance(fm, dict) and fm.get("flowpad_hook_id") == eid:
                    return True
                if hook.get("_flowpad_hook_id") == eid:
                    return True
                return False

            try:
                with open(self.path, "r") as f:
                    data = json.load(f)

                hooks_data = data.get("hooks", {})
                found = False

                for event_name, event_entries in hooks_data.items():
                    if not isinstance(event_entries, list):
                        continue

                    # Search through entries and remove the one containing matching hook
                    new_event_entries = []
                    for entry_data in event_entries:
                        hooks_list = entry_data.get("hooks", [])
                        contains_matching_hook = any(
                            isinstance(hook, dict) and _matches_hook_id(hook, entry_id) for hook in hooks_list
                        )

                        if contains_matching_hook:
                            filtered_hooks = [
                                h for h in hooks_list if not (isinstance(h, dict) and _matches_hook_id(h, entry_id))
                            ]

                            # Only keep entry if it still has hooks after filtering
                            if filtered_hooks:
                                entry_data["hooks"] = filtered_hooks
                                new_event_entries.append(entry_data)

                            found = True
                        else:
                            new_event_entries.append(entry_data)

                    if found:
                        hooks_data[event_name] = new_event_entries
                        # Save the updated data
                        data["hooks"] = hooks_data
                        with open(self.path, "w") as f:
                            json.dump(data, f, indent=2)
                        # Reload entries from updated file
                        self._entries = self.provider.read(self.path)
                        return True

            except (json.JSONDecodeError, OSError):
                pass

        return False

    def remove_entries(self, event: str, matcher: Optional[str] = None) -> int:
        """Remove entries by event and optional matcher. Returns count removed."""
        before = len(self._entries)
        if matcher is None:
            self._entries = [e for e in self._entries if e.event != event]
        else:
            self._entries = [e for e in self._entries if not (e.event == event and e.matcher == matcher)]
        return before - len(self._entries)

    def list_events(self) -> list[str]:
        """List unique event names."""
        return list(set(e.event for e in self._entries))


def find_entry_by_id(entry_id: str, project_dir: Optional[str] = None) -> Optional[HookEntryResult]:
    """Find a hook entry by ID across local, project, and user hook files."""
    from flow_sdk.utils.claude_paths import get_claude_settings_path

    files_to_search = []
    project_path = Path(project_dir) if project_dir else None

    # Search in order: LOCAL, PROJECT, USER
    for scope in ["local", "project", "user"]:
        if scope == "user" or project_path:
            try:
                path = get_claude_settings_path(scope=scope, project_path=project_path)
                if path.exists():
                    files_to_search.append(path)
            except ValueError:
                # Skip if require_repo fails (we don't require repo here)
                pass

    # Search each file
    for file_path in files_to_search:
        hook_file = HookFile(file_path, ClaudeCodeHookFile())
        entry = hook_file.get_entry(entry_id)
        if entry:
            return HookEntryResult(entry=entry, file_path=file_path)

    return None
