"""ContactPermission — the host's standing grant for live sessions.

Covers self-registration, the pure grant decision (contact match × scope ×
action membership) for the ONE action ``auto_approve_session``, and the
read-side mapping of rows written under the retired per-message actions.
"""
import pytest

from flow_sdk.builtin.contact_permission import (
    ContactPermission,
    PermissionAction,
    _grants,
)

pytestmark = pytest.mark.timeout(30)  # do not increase timeout without approval

ALICE = "alice-user-id"
PROJ = "proj-1"
GRANT = PermissionAction.AUTO_APPROVE_SESSION.value


def _perm(**kw) -> ContactPermission:
    return ContactPermission.model_validate(kw)


def test_entity_self_registers():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    assert SchemaRegistry.get_entity_cls("contact_permission") is ContactPermission


def test_the_only_action_is_auto_approve_session():
    assert [a.value for a in PermissionAction] == ["auto_approve_session"]


def test_project_scoped_row_grants_for_that_project_only():
    rows = [_perm(contact_user_id=ALICE, project_id=PROJ, allowed_actions=[GRANT])]
    assert _grants(rows, action=GRANT, contact_user_id=ALICE, contact_email=None, project_id=PROJ) is True
    assert _grants(rows, action=GRANT, contact_user_id=ALICE, contact_email=None, project_id="proj-2") is False


def test_global_row_grants_for_any_project():
    rows = [_perm(contact_user_id=ALICE, project_id=None, allowed_actions=[GRANT])]
    assert _grants(rows, action=GRANT, contact_user_id=ALICE, contact_email=None, project_id="any") is True
    assert _grants(rows, action=GRANT, contact_user_id=ALICE, contact_email=None, project_id=None) is True


def test_email_fallback_matches_case_insensitively():
    rows = [_perm(contact_email="Alice@Example.com", project_id=None, allowed_actions=[GRANT])]
    assert _grants(rows, action=GRANT, contact_user_id="some-id",
                   contact_email="alice@example.com", project_id=PROJ) is True


def test_no_match_for_other_contact():
    rows = [_perm(contact_user_id=ALICE, project_id=None, allowed_actions=[GRANT])]
    assert _grants(rows, action=GRANT, contact_user_id="bob-id", contact_email="bob@example.com", project_id=PROJ) is False


def test_no_contact_key_never_grants():
    rows = [_perm(contact_user_id=ALICE, project_id=None, allowed_actions=[GRANT])]
    assert _grants(rows, action=GRANT, contact_user_id=None, contact_email=None, project_id=PROJ) is False


def test_legacy_execute_prompt_maps_to_auto_approve_session():
    """A row written when "run without asking" was per message now means
    "sessions from this contact start approved"."""
    row = _perm(contact_user_id=ALICE, allowed_actions=["execute_prompt"])
    assert row.allowed_actions == [GRANT]
    assert _grants([row], action=GRANT, contact_user_id=ALICE, contact_email=None, project_id=PROJ) is True


def test_legacy_auto_reply_is_dropped():
    """Reply mode lives on the session now; an old auto_reply grant is no grant."""
    row = _perm(contact_user_id=ALICE, allowed_actions=["auto_reply"])
    assert row.allowed_actions == []
    assert _grants([row], action=GRANT, contact_user_id=ALICE, contact_email=None, project_id=PROJ) is False


def test_unknown_and_duplicate_actions_are_normalized():
    row = _perm(contact_user_id=ALICE, allowed_actions=["execute_prompt", GRANT, "made_up"])
    assert row.allowed_actions == [GRANT]
