"""ClaudePluginFsRecord — represents an installed Claude Code plugin.

Source: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/
Plugins are cached by marketplace, plugin name, and commit hash version.
Enablement state is in ~/.claude/settings.json under ``enabledPlugins``.
"""

from __future__ import annotations

from typing import ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudePluginFsRecord(Record):
    """An installed Claude Code plugin.

    Mapped from ``~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/``.
    """

    def __init__(self, **kwargs):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.PLUGIN
        kwargs.setdefault("plugin_name", "")
        kwargs.setdefault("marketplace", "")
        kwargs.setdefault("version_hash", "")
        kwargs.setdefault("enabled", False)
        kwargs.setdefault("plugin_path", "")
        super().__init__(**kwargs)
        if self.plugin_name and self.marketplace:
            self.id = f"{self.plugin_name}@{self.marketplace}"
            if not self.name:
                self.name = self.plugin_name
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
