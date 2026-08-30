"""The EnvVar table on an entity — CRUD, masking, and the ref/consent join.

Ported from the hub's ``flowpad/hub/tests/unit/test_env_table.py``. The
``env_types``/``env_table`` modules are byte-identical to the hub's, but until
now nothing in this repo tested them, so the two branches of
``resolve_var_status`` that depend on ``ref_type``/``allowed_to_use`` were
never exercised here at all.
"""

import uuid

import pytest

from flow_sdk.app.actions.env_var import owns_its_value, store_env_var_value
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.user import User
from flow_sdk.core.entity.entity_env.env_table import merge_env_tables, resolve_var_status
from flow_sdk.core.entity.entity_env.env_types import (
    EntityEnvVars,
    EnvStatusEnum,
    EnvVar,
    EnvVarType,
)
from flow_sdk.core.entity.entity_env.env_utils import is_confidential, mask_confidential_value
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_entity_credentials
from flow_sdk.schema.type_info import register_all

register_all()


async def _project(name="env-table-proj"):
    project = Project(name=name)
    await project.save()
    return project


# ── CRUD ──────────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_basic_plain_env_var_round_trips(sod_env):
    project = await _project()
    project.set_env_var(
        EnvVar(
            name="NO_SECRET",
            description="Just a normal env var",
            var_type=EnvVarType.PLAIN,
            visible_value="plain-value",
        )
    )
    await project.update()

    fetched = await Project.get_by_id(project.id)
    assert len(fetched.env_vars.values) == 1
    assert fetched.env_vars.values[0].name == "NO_SECRET"
    # PLAIN keeps its value on the row — that is the whole point of the type.
    assert fetched.env_vars.values[0].visible_value == "plain-value"


@pytest.mark.asyncio
async def test_secret_env_var_value_is_masked_on_the_row(sod_env):
    project = await _project()
    entity_var = EnvVar(name="SECRET_KEY", description="A secret API key", var_type=EnvVarType.API_KEY)
    await store_env_var_value(entity_var, "sk-live-0123456789abcd", project.typeid)
    project.set_env_var(entity_var)
    await project.update()

    fetched = await Project.get_by_id(project.id)
    row = fetched.env_vars.values[0]
    assert row.var_type == EnvVarType.API_KEY
    assert row.visible_value == "****abcd"
    assert "sk-live-0123456789abcd" not in str(fetched.model_dump())
    # ...and the real value is in SOD, reachable only in-process.
    assert await get_entity_credentials(project, "SECRET_KEY") == "sk-live-0123456789abcd"


@pytest.mark.asyncio
async def test_update_env_var_description_and_value(sod_env):
    project = await _project()
    entity_var = EnvVar(name="SECRET_KEY", var_type=EnvVarType.API_KEY, description="first")
    await store_env_var_value(entity_var, "sk-first-aaaa", project.typeid)
    project.set_env_var(entity_var)
    await project.update()

    project.update_env_var_description("SECRET_KEY", "second")
    await store_env_var_value(project.get_env_var("SECRET_KEY"), "sk-second-bbbb", project.typeid)
    await project.update()

    fetched = await Project.get_by_id(project.id)
    row = fetched.env_vars.values[0]
    assert row.description == "second"
    assert row.visible_value == "****bbbb"
    assert await get_entity_credentials(project, "SECRET_KEY") == "sk-second-bbbb"


@pytest.mark.asyncio
async def test_delete_env_var_removes_the_row(sod_env):
    project = await _project()
    project.set_env_var(EnvVar(name="GONE", var_type=EnvVarType.PLAIN, visible_value="x"))
    await project.save()

    assert project.remove_env_var("GONE") is True
    await project.update()

    fetched = await Project.get_by_id(project.id)
    assert fetched.get_env_var("GONE") is None
    # Removing something absent is a no-op, not an error.
    assert fetched.remove_env_var("GONE") is False


@pytest.mark.asyncio
async def test_set_env_var_is_upsert_not_append(sod_env):
    project = await _project()
    project.set_env_var(EnvVar(name="SAME", var_type=EnvVarType.PLAIN, visible_value="one"))
    project.set_env_var(EnvVar(name="SAME", var_type=EnvVarType.PLAIN, visible_value="two"))
    await project.update()

    assert len(project.env_vars.values) == 1
    assert project.get_env_var("SAME").visible_value == "two"


# ── masking / classification ──────────────────────────────────────────────────


def test_is_confidential_covers_exactly_the_secret_types():
    assert is_confidential(EnvVarType.API_KEY) is True
    assert is_confidential(EnvVarType.OAUTH_TOKEN) is True
    assert is_confidential(EnvVarType.PLAIN) is False
    # A provider id is a pointer, not a secret.
    assert is_confidential(EnvVarType.OAUTH_PROVIDER_ID) is False


def test_mask_confidential_value_boundaries():
    assert mask_confidential_value("abcdefgh") == "****efgh"
    assert mask_confidential_value("abcd") == "****"
    assert mask_confidential_value("a") == "****"
    assert mask_confidential_value("") == "****"


# ── the ref / consent join ────────────────────────────────────────────────────


def _user_table(*vars_: EnvVar) -> EntityEnvVars:
    return EntityEnvVars(values=list(vars_))


def test_ref_without_a_matching_owner_row_is_missing():
    base = EnvVar(name="GH_OF_PROJECT", var_type=EnvVarType.OAUTH_TOKEN,
                  ref_type=BuiltinEntityType.USER, ref_name="github_credentials")

    assert resolve_var_status(base, None) == EnvStatusEnum.MISSING


def test_ref_without_consent_is_consent_required(sod_env):
    project_typeid = Project(name="p").typeid
    base = EnvVar(name="GH_OF_PROJECT", var_type=EnvVarType.OAUTH_TOKEN,
                  ref_type=BuiltinEntityType.USER, ref_name="github_credentials")
    owner = EnvVar(name="github_credentials", var_type=EnvVarType.OAUTH_TOKEN)

    assert resolve_var_status(base, owner, project_typeid) == EnvStatusEnum.CONSENT_REQUIRED


def test_ref_with_consent_is_available(sod_env):
    project_typeid = Project(name="p").typeid
    base = EnvVar(name="GH_OF_PROJECT", var_type=EnvVarType.OAUTH_TOKEN,
                  ref_type=BuiltinEntityType.USER, ref_name="github_credentials")
    owner = EnvVar(name="github_credentials", var_type=EnvVarType.OAUTH_TOKEN)
    owner.share_with(project_typeid)

    assert resolve_var_status(base, owner, project_typeid) == EnvStatusEnum.AVAILABLE

    owner.revoke_from(project_typeid)
    assert resolve_var_status(base, owner, project_typeid) == EnvStatusEnum.CONSENT_REQUIRED


def test_plain_and_key_status_follows_visible_value():
    assert resolve_var_status(EnvVar(name="A", var_type=EnvVarType.PLAIN, visible_value="v"), None) == (
        EnvStatusEnum.AVAILABLE
    )
    assert resolve_var_status(EnvVar(name="A", var_type=EnvVarType.PLAIN), None) == EnvStatusEnum.MISSING
    assert resolve_var_status(EnvVar(name="A", var_type=EnvVarType.API_KEY, visible_value="****abcd"), None) == (
        EnvStatusEnum.AVAILABLE
    )


def test_merge_env_tables_walks_base_rows_only(sod_env):
    project_typeid = Project(name="p").typeid
    owner = EnvVar(name="github_credentials", var_type=EnvVarType.OAUTH_TOKEN)
    owner.share_with(project_typeid)
    base = EntityEnvVars(
        values=[
            EnvVar(name="GH_OF_PROJECT", var_type=EnvVarType.OAUTH_TOKEN,
                   ref_type=BuiltinEntityType.USER, ref_name="github_credentials"),
            EnvVar(name="PLAIN_ONE", var_type=EnvVarType.PLAIN, visible_value="v"),
        ]
    )

    merged = merge_env_tables(base, _user_table(owner, EnvVar(name="UNRELATED", var_type=EnvVarType.PLAIN)),
                              base_entity_typeid=project_typeid)

    # Two base rows in, two status rows out — the join table contributes status,
    # never extra rows.
    assert [r.name for r in merged.values] == ["GH_OF_PROJECT", "PLAIN_ONE"]
    assert merged.values[0].var_status == EnvStatusEnum.AVAILABLE
    assert merged.values[1].var_status == EnvStatusEnum.AVAILABLE


def test_oauth_provider_row_status(sod_env):
    """A provider row is a pointer; its status reflects whether the user holds
    the token it names."""
    provider = EnvVar(name="github", var_type=EnvVarType.OAUTH_PROVIDER_ID,
                      ref_type=BuiltinEntityType.USER, ref_name="github_credentials")

    assert resolve_var_status(provider, None) == EnvStatusEnum.MISSING

    token = EnvVar(name="github_credentials", var_type=EnvVarType.OAUTH_TOKEN)
    assert resolve_var_status(provider, token) == EnvStatusEnum.AVAILABLE

    wrong_kind = EnvVar(name="github_credentials", var_type=EnvVarType.PLAIN)
    assert resolve_var_status(provider, wrong_kind) == EnvStatusEnum.ERROR


# ── ownership ────────────────────────────────────────────────────────────────


@pytest.mark.asyncio
async def test_owns_its_value_distinguishes_owner_rows_from_borrowed_refs(sod_env):
    project = await _project()
    user = User(name="owner-user")
    await user.save()

    plain_owner = EnvVar(name="A", var_type=EnvVarType.API_KEY)
    self_pointing_owner = EnvVar(name="B", var_type=EnvVarType.API_KEY,
                                 ref_type=BuiltinEntityType.USER, ref_name="B")
    borrowed = EnvVar(name="GH_OF_PROJECT", var_type=EnvVarType.OAUTH_TOKEN,
                      ref_type=BuiltinEntityType.USER, ref_name="github_credentials")

    assert owns_its_value(plain_owner, project) is True
    assert owns_its_value(self_pointing_owner, user) is True, "a user's own key is an owner row"
    assert owns_its_value(borrowed, project) is False, "a project borrowing a user's token owns nothing"


# ── the predicate-shape contract ──────────────────────────────────────────────
#
# `resolve_var_status` reads `base_var.is_plain`/`is_key` without calling them.
# They used to be plain methods while `is_ref`/`is_oauth_provider` were
# properties, so that test was on two bound method objects — always truthy. The
# branch ran for every row, NA became unreachable, and an OAUTH_TOKEN row was
# judged by `visible_value` (None on a token row) and reported MISSING. Nothing
# raised. These two tests are what would have caught it.


def test_every_env_var_predicate_is_a_property_not_a_method():
    """A bound method is truthy, so a method here is a silent always-true branch."""
    plain = EnvVar(name="X", var_type=EnvVarType.PLAIN, visible_value="v")
    for predicate in ("is_ref", "is_oauth_provider", "is_key", "is_plain",
                      "is_flowpad_api_key", "has_key_id"):
        value = getattr(plain, predicate)
        assert isinstance(value, bool), (
            f"EnvVar.{predicate} returned {type(value).__name__}, not bool — a "
            "zero-argument predicate here must be a @property, or every call "
            "site that reads it without parentheses silently sees True"
        )


def test_na_is_reachable_for_a_row_that_is_neither_plain_key_nor_ref():
    """NA means "this row's status is not a question this table answers".

    An OAUTH_TOKEN row is exactly that: it is the join target, not a base row,
    so none of the typed branches apply. While the predicates were methods this
    return was dead code — which is the cheapest proof the bug existed.
    """
    token_row = EnvVar(name="github_credentials", var_type=EnvVarType.OAUTH_TOKEN)
    assert resolve_var_status(token_row, None) is EnvStatusEnum.NA


# ── whose account is this? ────────────────────────────────────────────────────
#
# "Latest login wins" is the right rule for the credential store, but until the
# account was recorded nothing could tell that the winner was a DIFFERENT
# account. A consumer granted workspace A kept reading AVAILABLE while pointing
# at workspace B, because the join only checks that a name-matching row exists.


def _bound_pair(bound: str | None, held: str | None):
    """A borrower's reference row + the owner's credential row it points at."""
    borrower = EnvVar(
        name="slack_in_project",
        var_type=EnvVarType.OAUTH_TOKEN,
        ref_type=BuiltinEntityType.USER,
        ref_name="slack_credentials",
        bound_account_key=bound,
    )
    owner = EnvVar(
        name="slack_credentials",
        var_type=EnvVarType.OAUTH_TOKEN,
        account_key=held,
    )
    return borrower, owner


def test_a_reconnect_as_a_different_account_needs_consent_again():
    project = TypeId(type=BuiltinEntityType.PROJECT.value, id=str(uuid.uuid4()))
    borrower, owner = _bound_pair(bound="T_OLD:U1", held="T_NEW:U1")
    owner.share_with(project)

    assert resolve_var_status(borrower, owner, project) is EnvStatusEnum.CONSENT_REQUIRED, (
        "the held credential belongs to a different provider account than the one "
        "this project was granted — silently following it would point the project "
        "at a workspace nobody here agreed to"
    )


def test_the_same_account_stays_available_across_a_reconnect():
    project = TypeId(type=BuiltinEntityType.PROJECT.value, id=str(uuid.uuid4()))
    borrower, owner = _bound_pair(bound="T1:U1", held="T1:U1")
    owner.share_with(project)

    assert resolve_var_status(borrower, owner, project) is EnvStatusEnum.AVAILABLE


def test_an_unidentified_account_never_counts_as_a_mismatch():
    """Providers that do not identify their accounts leave both sides None.
    A None must not be read as 'different' — that would break every provider
    without an account_key extractor."""
    project = TypeId(type=BuiltinEntityType.PROJECT.value, id=str(uuid.uuid4()))
    for bound, held in ((None, "T1:U1"), ("T1:U1", None), (None, None)):
        borrower, owner = _bound_pair(bound=bound, held=held)
        owner.share_with(project)
        assert resolve_var_status(borrower, owner, project) is EnvStatusEnum.AVAILABLE, (
            f"bound={bound!r} held={held!r} must not be treated as a mismatch"
        )
