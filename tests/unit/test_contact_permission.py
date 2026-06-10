"""ContactPermission — the receiver's local prompt-permission policy.

Covers self-registration (the type resolves through the entity registry) and
the pure permission decision: contact match (user id / email) × scope (project
vs global) × action membership.
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


def _perm(**kw) -> ContactPermission:
    return ContactPermission.model_validate(kw)


def test_entity_self_registers():
    from flow_sdk.fs_store.schema_registry import SchemaRegistry
    assert SchemaRegistry.get_entity_cls("contact_permission") is ContactPermission


def test_project_scoped_row_grants_for_that_project_only():
    rows = [_perm(contact_user_id=ALICE, project_id=PROJ,
                  allowed_actions=[PermissionAction.EXECUTE_PROMPT.value])]
    assert _grants(rows, action="execute_prompt", contact_user_id=ALICE,
                   contact_email=None, project_id=PROJ) is True
    # Different project → not granted (the row is scoped to PROJ).
    assert _grants(rows, action="execute_prompt", contact_user_id=ALICE,
                   contact_email=None, project_id="proj-2") is False


def test_global_row_grants_for_any_project():
    rows = [_perm(contact_user_id=ALICE, project_id=None,
                  allowed_actions=[PermissionAction.EXECUTE_PROMPT.value])]
    assert _grants(rows, action="execute_prompt", contact_user_id=ALICE,
                   contact_email=None, project_id="any-project") is True
    assert _grants(rows, action="execute_prompt", contact_user_id=ALICE,
                   contact_email=None, project_id=None) is True


def test_action_must_be_in_allowed_actions():
    rows = [_perm(contact_user_id=ALICE, project_id=None,
                  allowed_actions=[PermissionAction.EXECUTE_PROMPT.value])]
    # execute granted, but auto_reply is NOT in the list.
    assert _grants(rows, action="execute_prompt", contact_user_id=ALICE,
                   contact_email=None, project_id=PROJ) is True
    assert _grants(rows, action="auto_reply", contact_user_id=ALICE,
                   contact_email=None, project_id=PROJ) is False


def test_email_fallback_matches_case_insensitively():
    rows = [_perm(contact_email="Alice@Example.com", project_id=None,
                  allowed_actions=[PermissionAction.AUTO_REPLY.value])]
    # No user id on the row; match by email regardless of case.
    assert _grants(rows, action="auto_reply", contact_user_id="some-id",
                   contact_email="alice@example.com", project_id=PROJ) is True


def test_no_match_for_other_contact():
    rows = [_perm(contact_user_id=ALICE, project_id=None,
                  allowed_actions=[PermissionAction.EXECUTE_PROMPT.value])]
    assert _grants(rows, action="execute_prompt", contact_user_id="bob-id",
                   contact_email="bob@example.com", project_id=PROJ) is False


def test_no_contact_key_never_grants():
    rows = [_perm(contact_user_id=ALICE, project_id=None,
                  allowed_actions=[PermissionAction.EXECUTE_PROMPT.value])]
    assert _grants(rows, action="execute_prompt", contact_user_id=None,
                   contact_email=None, project_id=PROJ) is False
