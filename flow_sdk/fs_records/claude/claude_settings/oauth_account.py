"""ClaudeOAuthAccountFsRecord -- OAuth account from ~/.claude.json /oauthAccount."""

from __future__ import annotations

from typing import Any, ClassVar

from flow_sdk.fs_store import Record, RecordType


class ClaudeOAuthAccountFsRecord(Record):
    """OAuth account credentials and metadata."""

    _record_type: ClassVar[str] = RecordType.CLAUDE_SETTINGS_OAUTH

    def __init__(self, **kwargs: Any):
        if "type" not in kwargs:
            kwargs["type"] = RecordType.CLAUDE_SETTINGS_OAUTH
        super().__init__(**kwargs)
        from flow_sdk.fs_store.fs_ref import FSRef
        object.__setattr__(self, "_asset_ref", FSRef("/", read_only=True))
        if self.account_uuid and not object.__getattribute__(self, "__dict__").get("id"):
            object.__getattribute__(self, "__dict__")["id"] = self.account_uuid

    @property
    def account_uuid(self) -> str:
        return object.__getattribute__(self, "__dict__").get("account_uuid") or ""

    @classmethod
    def from_raw(cls, data: dict) -> ClaudeOAuthAccountFsRecord:
        """Create from the oauthAccount sub-object."""
        rec = cls(
            account_uuid=data.get("accountUuid", ""),
            email_address=data.get("emailAddress", ""),
            organization_uuid=data.get("organizationUuid", ""),
            has_extra_usage_enabled=data.get("hasExtraUsageEnabled", False),
            billing_type=data.get("billingType", ""),
            account_created_at=data.get("accountCreatedAt", ""),
            subscription_created_at=data.get("subscriptionCreatedAt", ""),
            display_name=data.get("displayName", ""),
        )
        rec.id = rec.account_uuid or "default"
        return rec
