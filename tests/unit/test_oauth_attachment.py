"""Attaching a user's OAuth credential to a project — the two-sided share.

Until now oss had stubs here: attach/detach returned 200 and mutated nothing,
so `allowed_to_use` was never populated and `resolve_var_status`'s
CONSENT_REQUIRED branch was unreachable. These are the first tests in this repo
that exercise it.

The invariant under test is the DIRECTION: a connection may carry a reference
to a secret; a secret never carries a required reference to a connection. The
consent list lives on the credential's owner, the reference row lives on the
borrower.
"""

import pytest

from flow_sdk.app.actions.env_var import add_env_var_to_entity
from flow_sdk.app.actions.oauth_attachment import (
    disconnect_oauth_provider,
    revoke_var_from,
    share_var_with,
)
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.core.entity.entity_env.env_table import resolve_var_status
from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum, EnvVarType
from flow_sdk.core.entity.entity_env.env_utils import build_shared_var_name
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_user_credentials
from flow_sdk.schema.type_info import register_all

register_all()

CRED = "github_credentials"
# Matches the hub verbatim: the base name is NOT upper-cased, only the suffix.
BORROWED = build_shared_var_name(CRED, "project")


async def _user_with_token(name="attach-user"):
    user = User(name=name)
    await user.save()
    await add_env_var_to_entity(user, CRED, EnvVarType.OAUTH_TOKEN, value="gho_secret")
    return user


async def _project(name="attach-proj"):
    project = Project(name=name)
    await project.save()
    return project


@pytest.mark.asyncio
async def test_attach_writes_both_sides(sod_env):
    user = await _user_with_token()
    project = await _project()

    result = await share_var_with(user, CRED, project.typeid)

    assert result.success, result
    # Side 1: consent on the OWNER.
    assert user.get_env_var(CRED).is_allowed(project.typeid)
    # Side 2: a value-free reference on the BORROWER, pointing back. Re-read:
    # share_var_with resolves the target from its typeid, so it writes to its
    # own instance -- the same thing the real attach path does.
    project = await Project.get_by_id(project.id)
    ref = project.get_env_var(BORROWED)
    assert ref is not None
    assert ref.ref_type == BuiltinEntityType.USER
    assert ref.ref_name == CRED
    assert ref.visible_value is None, "the reference row must hold no value"


@pytest.mark.asyncio
async def test_the_secret_never_points_at_the_connection(sod_env):
    """Direction check. The borrower's row references the owner; the owner's
    credential carries only a consent list, never a back-reference."""
    user = await _user_with_token()
    project = await _project()

    await share_var_with(user, CRED, project.typeid)

    owner_row = user.get_env_var(CRED)
    assert owner_row.allowed_to_use == [project.typeid]
    # Self-pointing owner row — it names ITSELF, never the project that borrows
    # it. Only the borrower's row carries a cross-entity reference.
    assert owner_row.ref_name == CRED
    assert owner_row.ref_type == BuiltinEntityType.USER


@pytest.mark.asyncio
async def test_attach_makes_the_consent_branch_reachable(sod_env):
    """Before the attach the merged table says CONSENT_REQUIRED; after it,
    AVAILABLE. Neither branch was reachable in this repo before now."""
    user = await _user_with_token()
    project = await _project()
    await share_var_with(user, CRED, project.typeid)
    ref = (await Project.get_by_id(project.id)).get_env_var(BORROWED)
    owner = user.get_env_var(CRED)

    assert resolve_var_status(ref, owner, project.typeid) == EnvStatusEnum.AVAILABLE

    owner.revoke_from(project.typeid)
    assert resolve_var_status(ref, owner, project.typeid) == EnvStatusEnum.CONSENT_REQUIRED


@pytest.mark.asyncio
async def test_attach_is_idempotent(sod_env):
    user = await _user_with_token()
    project = await _project()

    await share_var_with(user, CRED, project.typeid)
    second = await share_var_with(user, CRED, project.typeid)

    assert second.success
    assert user.get_env_var(CRED).allowed_to_use == [project.typeid]
    refreshed = await Project.get_by_id(project.id)
    assert len([v for v in refreshed.env_vars.values if v.ref_name == CRED]) == 1


@pytest.mark.asyncio
async def test_detach_cleans_both_sides_and_reports_the_real_count(sod_env):
    user = await _user_with_token()
    a = await _project("proj-a")
    b = await _project("proj-b")
    await share_var_with(user, CRED, a.typeid)
    await share_var_with(user, CRED, b.typeid)

    result = await revoke_var_from(user, CRED, a.typeid)

    assert result.success
    # The REAL count, not a hardcoded 0 — the stub's 0 is what made the client
    # chain into disconnect and destroy the token on every project detach.
    assert result.remaining_attachment_count == 1
    assert not user.get_env_var(CRED).is_allowed(a.typeid)
    refreshed_a = await Project.get_by_id(a.id)
    assert refreshed_a.get_env_var(BORROWED) is None


@pytest.mark.asyncio
async def test_detach_keeps_the_credential(sod_env):
    """Detaching from the last project must NOT delete the token. Detach,
    disconnect and delete are three separate verbs."""
    user = await _user_with_token()
    project = await _project()
    await share_var_with(user, CRED, project.typeid)

    result = await revoke_var_from(user, CRED, project.typeid)

    assert result.remaining_attachment_count == 0
    assert await get_user_credentials(user, CRED, user.id) == "gho_secret"


@pytest.mark.asyncio
async def test_double_detach_is_idempotent_not_a_500(sod_env):
    user = await _user_with_token()
    project = await _project()
    await share_var_with(user, CRED, project.typeid)

    await revoke_var_from(user, CRED, project.typeid)
    second = await revoke_var_from(user, CRED, project.typeid)

    assert second.success


@pytest.mark.asyncio
async def test_attach_fails_cleanly_when_the_user_holds_no_credential(sod_env):
    user = User(name="no-token-user")
    await user.save()
    project = await _project()

    result = await share_var_with(user, CRED, project.typeid)

    assert result.success is False
    assert result.error == "sod_not_found_in_env_vars"


@pytest.mark.asyncio
async def test_disconnect_removes_the_credential_itself(sod_env):
    user = await _user_with_token()

    result = await disconnect_oauth_provider(user, "github")

    assert result.success, result
    assert user.get_env_var(CRED) is None
    try:
        left = await get_user_credentials(user, CRED, user.id)
    except KeyError:
        left = None
    assert left is None, "disconnect must remove the stored value too"
