"""ClaudeSandboxFsRecord — sandbox block from settings.json."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeSandboxFsRecord(Record):
    """Sandbox configuration from settings.json ``sandbox`` block.

    Controls command sandboxing and network access restrictions.
    """

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_JSON_SANDBOX

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_JSON_SANDBOX
        super().__init__(**kwargs)

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeSandboxFsRecord:
        """Create from a ``sandbox`` block."""
        network = data.get("network", {})
        rec = cls(
            enabled=data.get("enabled", False),
            auto_allow_bash_if_sandboxed=data.get("autoAllowBashIfSandboxed", False),
            excluded_commands=data.get("excludedCommands", []),
            allow_unsandboxed_commands=data.get("allowUnsandboxedCommands", False),
            enable_weaker_nested_sandbox=data.get("enableWeakerNestedSandbox", False),
            # Network sub-block (flattened)
            network_allowed_domains=network.get("allowedDomains", []),
            network_allow_unix_sockets=network.get("allowUnixSockets", []),
            network_allow_all_unix_sockets=network.get("allowAllUnixSockets", False),
            network_allow_local_binding=network.get("allowLocalBinding", False),
            network_http_proxy_port=network.get("httpProxyPort", 0),
            network_socks_proxy_port=network.get("socksProxyPort", 0),
        )
        import uuid as _uuid
        rec.id = str(_uuid.uuid5(_uuid.NAMESPACE_DNS, "claude_settings_json_sandbox:default"))
        return rec
