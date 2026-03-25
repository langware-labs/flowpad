"""Unit tests for SkillNotification model and WebhookType enum.

Adapted from FlowPad: flowpad/hub/tests/unit/test_skill_notification.py
"""

from flow_sdk.core.flow.models.webhook_flow_data import (
    SkillNotification,
    WebhookPayload,
    WebhookType,
)


class TestSkillNotification:
    """Tests for SkillNotification model."""

    def test_create_skill_notification(self):
        """Test creating SkillNotification with all fields."""
        notification = SkillNotification(
            skill_name="skillit",
            matched_keyword="skillit",
            prompt="user prompt text",
            handler_name="handle_analyze",
            folder_path="/path/to/working/dir",
        )

        assert notification.skill_name == "skillit"
        assert notification.matched_keyword == "skillit"
        assert notification.prompt == "user prompt text"
        assert notification.handler_name == "handle_analyze"
        assert notification.folder_path == "/path/to/working/dir"

    def test_create_skill_notification_minimal(self):
        """Test creating SkillNotification with only required fields."""
        notification = SkillNotification(skill_name="minimal_skill")

        assert notification.skill_name == "minimal_skill"
        assert notification.matched_keyword is None
        assert notification.prompt is None
        assert notification.handler_name is None
        assert notification.folder_path is None


class TestWebhookType:
    """Tests for the consolidated 2-value WebhookType enum."""

    def test_only_two_types(self):
        """WebhookType has exactly 2 values: agent_hook and hook_op."""
        assert len(WebhookType) == 2
        assert set(t.value for t in WebhookType) == {"agent_hook", "hook_op"}

    def test_agent_hook_value(self):
        assert WebhookType.AGENT_HOOK == "agent_hook"

    def test_hook_op_value(self):
        assert WebhookType.HOOK_OP == "hook_op"

    def test_webhook_payload_accepts_agent_hook(self):
        envelope = WebhookPayload(
            webhook_type="agent_hook",
            webhook_payload={"agent_hook_id": "hook-1", "hook_data": {}},
        )
        assert envelope.webhook_type == WebhookType.AGENT_HOOK

    def test_webhook_payload_accepts_hook_op(self):
        envelope = WebhookPayload(
            webhook_type="hook_op",
            webhook_payload={"type": "task", "id": "t-1", "operation": "create"},
        )
        assert envelope.webhook_type == WebhookType.HOOK_OP

    def test_webhook_payload_rejects_old_types(self):
        """Old webhook types like instruction_trace, skill_notification, etc. are no longer valid."""
        import pytest
        from pydantic import ValidationError

        for old_type in ("instruction_trace", "skill_notification", "activation_rules", "skillit_log", "mcp_webhook", "resource_sync"):
            with pytest.raises(ValidationError):
                WebhookPayload(webhook_type=old_type, webhook_payload={})
