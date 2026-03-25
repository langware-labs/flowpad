"""ClaudeFeatureFlagsFsRecord -- feature flags from ~/.claude.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeFeatureFlagsFsRecord(Record):
    """Feature flags aggregated from Statsig gates, dynamic configs, and GrowthBook."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_FEATURE_FLAGS

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_FEATURE_FLAGS
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))

    def get_flag(self, name: str) -> Any:
        """Look up a flag by name across all three sources.

        Searches statsig gates first, then dynamic configs, then growthbook.
        Returns ``None`` if not found in any source.
        """
        if name in self.cached_statsig_gates:
            return self.cached_statsig_gates[name]
        if name in self.cached_dynamic_configs:
            return self.cached_dynamic_configs[name]
        if name in self.cached_growthbook_features:
            return self.cached_growthbook_features[name]
        return None

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeFeatureFlagsFsRecord:
        """Create from the root ~/.claude.json data (extracts all three flag dicts)."""
        rec = cls(
            cached_statsig_gates=data.get("cachedStatsigGates", {}),
            cached_dynamic_configs=data.get("cachedDynamicConfigs", {}),
            cached_growthbook_features=data.get("cachedGrowthBookFeatures", {}),
        )
        rec.id = "default"
        return rec
