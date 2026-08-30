"""Claude Code settings.json hook file provider."""

import json
from pathlib import Path
from typing import Any

from flow_sdk.hooks.models import AgentHookMetadata, HookEntry


class ClaudeCodeHookFile:
    """
    Claude Code settings.json format handler.

    File format:
    {
      "hooks": {
        "EventName": [
          {
            "matcher": "ToolPattern",  // optional
            "hooks": [{"type": "command", "command": "..."}],
            "flow": {"managed": true, "version": "1.0", ...}  // optional
          }
        ]
      }
    }
    """

    def read(self, path: Path) -> list[HookEntry]:
        """Read hooks from Claude Code settings.json."""
        if not path.exists():
            return []

        try:
            with open(path, "r") as f:
                data = json.load(f)
        except (json.JSONDecodeError, OSError):
            return []

        hooks_data = data.get("hooks", {})
        entries: list[HookEntry] = []

        for event_name, event_entries in hooks_data.items():
            if not isinstance(event_entries, list):
                continue

            for entry_data in event_entries:
                entry = self._parse_entry(event_name, entry_data)
                if entry:
                    entries.append(entry)

        return entries

    @staticmethod
    def _parse_entry(event_name: str, entry_data: dict[str, Any]) -> HookEntry | None:
        """Parse a single hook entry from settings.json format."""
        if not isinstance(entry_data, dict):
            return None

        hooks_list = entry_data.get("hooks", [])
        commands = [h.get("command") for h in hooks_list if h.get("command")]

        if not commands:
            return None

        # Extract hook entry ID from flow_metadata or legacy _flowpad_hook_id
        entry_id = None
        if hooks_list and isinstance(hooks_list[0], dict):
            fm = hooks_list[0].get("flow_metadata")
            if fm and isinstance(fm, dict):
                entry_id = fm.get("flowpad_hook_id")
            if not entry_id:
                entry_id = hooks_list[0].get("_flowpad_hook_id")

        flowpad_data = None
        flow = entry_data.get("flow")
        if flow and isinstance(flow, dict):
            flowpad_data = AgentHookMetadata(
                managed=flow.get("managed", True),
                version=flow.get("version", "1.0"),
                name=flow.get("name"),
                created_at=flow.get("created_at"),
                report_url=flow.get("report_url"),
            )

        entry_kwargs = {
            "event": event_name,
            "matcher": entry_data.get("matcher"),
            "commands": commands,
            "flowpad_data": flowpad_data,
        }
        if entry_id:
            entry_kwargs["id"] = entry_id

        return HookEntry(**entry_kwargs)

    def write(self, path: Path, entries: list[HookEntry]) -> None:
        """Write hooks to Claude Code settings.json."""
        # Load existing settings to preserve non-hook data
        existing: dict[str, Any] = {}
        if path.exists():
            try:
                with open(path, "r") as f:
                    existing = json.load(f)
            except (json.JSONDecodeError, OSError):
                pass

        # Group entries by event for the file format
        hooks_data: dict[str, list[dict[str, Any]]] = {}

        for entry in entries:
            entry_dict = self._serialize_entry(entry)
            if entry_dict:
                if entry.event not in hooks_data:
                    hooks_data[entry.event] = []
                hooks_data[entry.event].append(entry_dict)

        existing["hooks"] = hooks_data

        # Write file
        path.parent.mkdir(parents=True, exist_ok=True)
        with open(path, "w") as f:
            json.dump(existing, f, indent=2)

    @staticmethod
    def _serialize_entry(entry: HookEntry) -> dict[str, Any] | None:
        """Serialize HookEntry to settings.json entry format."""
        if not entry.commands:
            return None

        # Include flow_metadata in the first hook for ID persistence
        hooks_list = []
        for i, cmd in enumerate(entry.commands):
            hook_dict: dict[str, Any] = {"type": "command", "command": cmd}
            if i == 0:
                flow_metadata: dict[str, Any] = {
                    "name": (entry.flowpad_data.name if entry.flowpad_data and entry.flowpad_data.name else entry.id),
                    "hook_entry_id": entry.id,
                    "flowpad_hook_id": (
                        entry.flowpad_data.flowpad_hook_id
                        if entry.flowpad_data and entry.flowpad_data.flowpad_hook_id
                        else entry.id
                    ),
                }
                hook_dict["flow_metadata"] = flow_metadata
            hooks_list.append(hook_dict)

        result: dict[str, Any] = {"hooks": hooks_list}

        if entry.matcher:
            result["matcher"] = entry.matcher

        if entry.flowpad_data:
            flow_dict: dict[str, Any] = {"managed": entry.flowpad_data.managed}
            if entry.flowpad_data.version:
                flow_dict["version"] = entry.flowpad_data.version
            if entry.flowpad_data.name:
                flow_dict["name"] = entry.flowpad_data.name
            if entry.flowpad_data.created_at:
                flow_dict["created_at"] = entry.flowpad_data.created_at
            if entry.flowpad_data.report_url:
                flow_dict["report_url"] = entry.flowpad_data.report_url
            result["flow"] = flow_dict

        return result
