"""Create-then-delete leaves no orphaned value in SOD.

``store_env_var_value`` composes a *different* SOD key per branch — a user's
own key goes through ``set_user_credentials`` with ``foreign_key=user.id``,
everything else through ``set_entity_credentials``. Deletion has to take the
same branch or the value silently survives the row that named it.

Two bugs used to live here: the old predicate skipped every ``is_ref`` row
(which includes a user's own self-pointing key), and even when it fired it
composed the entity-scoped key for a value written under the user-scoped one.
"""

import pytest

from flow_sdk.app.actions.env_var import add_env_var_to_entity, delete_env_var_value
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.core.entity.entity_env.env_types import EnvVarType
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_entity_credentials, get_user_credentials
from flow_sdk.schema.type_info import register_all

register_all()


async def _project():
    project = Project(name="sod-lifecycle-proj")
    await project.save()
    return project


async def _user():
    user = User(name="sod-lifecycle-user")
    await user.save()
    return user


async def _entity_value_gone(entity, name) -> bool:
    try:
        return await get_entity_credentials(entity, name) is None
    except KeyError:
        return True


async def _user_value_gone(user, name) -> bool:
    try:
        return await get_user_credentials(user, name, user.id) is None
    except KeyError:
        return True


@pytest.mark.asyncio
async def test_project_plain_var_stores_nothing_in_sod(sod_env):
    project = await _project()

    var = await add_env_var_to_entity(project, "PLAIN_ONE", EnvVarType.PLAIN, value="not-a-secret")

    # A PLAIN value lives on the row, in the clear, by design.
    assert var.visible_value == "not-a-secret"
    assert await _entity_value_gone(project, "PLAIN_ONE")

    await delete_env_var_value(var, project)
    assert await _entity_value_gone(project, "PLAIN_ONE")


@pytest.mark.asyncio
async def test_project_api_key_round_trips_and_deletes(sod_env):
    project = await _project()

    var = await add_env_var_to_entity(project, "PROJECT_KEY", EnvVarType.API_KEY, value="sk-project-wxyz")

    assert var.visible_value == "****wxyz"
    assert await get_entity_credentials(project, "PROJECT_KEY") == "sk-project-wxyz"

    await delete_env_var_value(var, project)
    assert await _entity_value_gone(project, "PROJECT_KEY"), "project key orphaned in SOD"


@pytest.mark.asyncio
async def test_user_api_key_deletes_from_the_user_scoped_key(sod_env):
    """The orphan case. A user's own API key is marked ``ref_type=USER``, so the
    old ``not is_ref`` guard skipped it entirely and the value outlived the row."""
    user = await _user()

    var = await add_env_var_to_entity(user, "USER_KEY", EnvVarType.API_KEY, value="sk-user-mnop")

    assert var.ref_type == BuiltinEntityType.USER
    assert var.visible_value == "****mnop"
    assert await get_user_credentials(user, "USER_KEY", user.id) == "sk-user-mnop"

    await delete_env_var_value(var, user)
    assert await _user_value_gone(user, "USER_KEY"), "user key orphaned in SOD"


@pytest.mark.asyncio
async def test_user_oauth_token_is_a_self_pointing_owner_row(sod_env):
    """The credential row is named for the CREDENTIAL and points at itself. A
    project that borrows it mints its own row naming this one; the provider row
    (OAUTH_PROVIDER_ID) likewise names this one. Neither is this row's job."""
    user = await _user()

    var = await add_env_var_to_entity(user, "github_credentials", EnvVarType.OAUTH_TOKEN, value="gho_abcdefgh")

    assert var.ref_type == BuiltinEntityType.USER
    assert var.ref_name == "github_credentials"
    assert var.visible_value == "****efgh"
    assert await get_user_credentials(user, "github_credentials", user.id) == "gho_abcdefgh"

    await delete_env_var_value(var, user)
    assert await _user_value_gone(user, "github_credentials")


@pytest.mark.asyncio
async def test_borrowed_reference_never_deletes_the_owners_value(sod_env):
    """A project row pointing at a user's token owns nothing. Detaching it must
    leave the user's credential untouched."""
    user = await _user()
    project = await _project()

    owner = await add_env_var_to_entity(
        user, "github_credentials", EnvVarType.OAUTH_TOKEN, value="gho_owner_key"
    )
    borrowed = await add_env_var_to_entity(
        project, "GITHUB_OF_PROJECT", EnvVarType.OAUTH_TOKEN, value=None, skip_if_exists=True
    )
    borrowed.ref_type = BuiltinEntityType.USER
    borrowed.ref_name = owner.ref_name

    await delete_env_var_value(borrowed, project)

    assert await get_user_credentials(user, "github_credentials", user.id) == "gho_owner_key"


@pytest.mark.asyncio
async def test_a_confidential_var_on_a_project_is_not_a_ref(sod_env):
    """Only USER-owned confidential vars self-point; a project's own key has no
    ref at all, so it stores through set_entity_credentials."""
    project = await _project()

    var = await add_env_var_to_entity(project, "PROJECT_ONLY", EnvVarType.API_KEY, value="tok-1234")

    assert var.ref_type is None
    assert var.ref_name is None
