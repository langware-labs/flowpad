from flow_sdk.app.actions.flow_message_action import _invitation_matches_target

TARGET_ID = "11111111-1111-4111-8111-111111111111"
OTHER_ID = "22222222-2222-4222-8222-222222222222"


def test_invitation_target_filter_matches_conversation_membership_and_legacy_path() -> None:
    assert _invitation_matches_target({"conversation": {"id": TARGET_ID}}, TARGET_ID)
    assert _invitation_matches_target({"target": {"id": TARGET_ID}}, TARGET_ID)
    assert _invitation_matches_target({"target_url_path": f"/dock/conversation/{TARGET_ID}"}, TARGET_ID)


def test_invitation_target_filter_excludes_unrelated_pending_rows() -> None:
    assert not _invitation_matches_target({"conversation": {"id": OTHER_ID}}, TARGET_ID)
    assert not _invitation_matches_target({"target": {"id": OTHER_ID}}, TARGET_ID)
    assert not _invitation_matches_target({"target_url_path": f"/dock/conversation/{OTHER_ID}"}, TARGET_ID)


def test_invitation_target_filter_preserves_unscoped_sync() -> None:
    assert _invitation_matches_target({"conversation": {"id": OTHER_ID}}, None)
