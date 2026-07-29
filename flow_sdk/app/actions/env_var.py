"""Environment variable CRUD action handler.

Ported from FlowPad cloud (flowpad/hub/app/actions/env_var.py) for minihub local mode.
OAuth-specific logic is simplified since OAuth is not available in local mode.
"""

import os
import re
from typing import Optional

from fastapi import HTTPException
from pydantic import BaseModel, ValidationError, field_validator, model_validator
from starlette.requests import Request

from flow_sdk.actions import action
from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars, EnvVar, EnvVarType
from flow_sdk.core.entity.entity_env.env_utils import is_confidential, mask_confidential_value
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import (
    delete_entity_credentials,
    delete_user_credentials,
    get_current_request_info,
    set_entity_credentials,
    set_user_credentials,
)
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


async def store_env_var_value(entity_var: EnvVar, value: str, entity_typeid: TypeId) -> None:
    if is_confidential(entity_var.var_type):
        if entity_var.ref_type == BuiltinEntityType.USER:
            user_entity = await Entity.get_by_typeid(entity_typeid)
            if not user_entity:
                raise HTTPException(status_code=404, detail=f"User entity not found for typeid {entity_typeid}")

            cred_name = entity_var.ref_name or entity_var.name
            # foreign_key=user_entity.id matches the convention used by the
            # OAuth device-flow path in flow_sdk.app.actions.desktop_oauth so
            # writes/reads/deletes hit the same composed SOD key. Passing ""
            # would fall back to request_info.user_foreign_key (None on desktop)
            # and raise inside _get_user_sod_key.
            await set_user_credentials(user_entity, cred_name, value, user_entity.id)
        else:
            await set_entity_credentials(entity_typeid, entity_var.name, value)

        entity_var.visible_value = mask_confidential_value(value)
    else:
        entity_var.visible_value = value


def owns_its_value(entity_var: EnvVar, entity: Entity) -> bool:
    """Does ``entity`` hold this var's value, or is it borrowing someone else's?

    Two owner shapes: a plain row with no ref at all, and a self-pointing row
    (``ref_type`` equal to the entity's own type) — which is what a user's own
    API key or OAuth token looks like, because ``store_env_var_value`` routes
    those through ``set_user_credentials`` on the user itself.

    A row whose ``ref_type`` names a DIFFERENT type is a borrowed reference —
    a project pointing at a user's token. Deleting that row must never destroy
    the owner's secret.
    """
    if not entity_var.is_ref:
        return True
    return str(entity_var.ref_type) == str(entity.type)


async def delete_env_var_value(entity_var: EnvVar, entity: Entity) -> None:
    """Remove the stored value, mirroring ``store_env_var_value``'s own branch.

    The write side composes a *different* SOD key per branch, so deletion has
    to take the same branch or it silently orphans the entry: a user API key
    written via ``set_user_credentials(..., foreign_key=user.id)`` is not
    reachable by ``delete_entity_credentials``.
    """
    if not is_confidential(entity_var.var_type) or not owns_its_value(entity_var, entity):
        return
    if entity_var.ref_type == BuiltinEntityType.USER:
        cred_name = entity_var.ref_name or entity_var.name
        await delete_user_credentials(entity, cred_name, entity.id)
    else:
        await delete_entity_credentials(entity, entity_var.name)


def validate_env_var_name(name: str) -> str:
    if not re.match(r"^[A-Za-z0-9_]+$", name):
        raise HTTPException(
            status_code=400,
            detail="Env var name must contain only letters, numbers, and underscores",
        )
    return name


def validate_env_var_value(value: str) -> str:
    if len(value) > 8_000:
        raise HTTPException(status_code=400, detail="Env var value must be less than 8,000 characters")
    return value


async def add_env_var_to_entity(
    entity: Entity,
    name: str,
    var_type: EnvVarType,
    description: Optional[str] = None,
    value: Optional[str] = None,
    skip_if_exists: bool = False,
) -> EnvVar:
    # Check if env var already exists
    if entity.env_vars:
        existing_var = entity.get_env_var(name)
        if existing_var:
            if skip_if_exists:
                return existing_var
            raise HTTPException(status_code=400, detail=f"Env var '{name}' already exists")

        # Check for case-insensitive conflicts (prevent both "slack" and "SLACK" from existing)
        name_lower = name.lower()
        for existing_env_var in entity.env_vars.values:
            if existing_env_var.name.lower() == name_lower and existing_env_var.name != name:
                raise HTTPException(
                    status_code=400,
                    detail=f"Env var '{name}' conflicts with existing variable '{existing_env_var.name}' (case-insensitive match)",
                )

    ref_type = None
    ref_name = None

    if var_type in (EnvVarType.API_KEY, EnvVarType.OAUTH_TOKEN):
        # A confidential var owned by a USER is a self-pointing row: ref_type
        # USER, ref_name itself. That is what routes store/delete through
        # set_user_credentials, and what a project's borrowed reference points
        # BACK at (a project row carries ref_name=<this row's name>).
        #
        # The row is named for the credential (e.g. "github_credentials"), not
        # for the provider — the provider is a separate OAUTH_PROVIDER_ID row
        # whose ref_name names this one. Mapping provider → credential name is
        # the caller's job, via the provider registry.
        if entity.type == BuiltinEntityType.USER.value:
            ref_type = BuiltinEntityType.USER
            ref_name = name

    # Create the EnvVar object
    entity_var = EnvVar(name=name, var_type=var_type, description=description, ref_type=ref_type, ref_name=ref_name)

    # Store value if provided (in SOD for confidential, in visible_value for non-confidential)
    if value:
        await store_env_var_value(entity_var, value, entity.typeid)

    # Initialize env_vars if needed
    if entity.env_vars is None:
        entity.env_vars = EntityEnvVars[EnvVar]()

    # Add the env var to the entity
    entity.env_vars.append(entity_var)
    await entity.update()

    return entity_var


class EnvVarApiInfo(BaseModel):
    name: str
    var_type: EnvVarType = EnvVarType.PLAIN
    description: Optional[str] = None

    @field_validator("name", mode="before")
    def validate_name(cls, v: str) -> str:
        return validate_env_var_name(v)


class EnvVarApiInfoIn(EnvVarApiInfo):
    value: Optional[str] = None
    use_env_value: bool = False  # If True, read value from os.getenv(name)

    @field_validator("value", mode="before")
    def validate_value(cls, v: Optional[str]) -> Optional[str]:
        if v is not None:
            return validate_env_var_value(v)
        return v

    @field_validator("description", mode="before")
    def validate_description(cls, v: Optional[str]) -> Optional[str]:
        return v

    @model_validator(mode="before")
    @classmethod
    def validate_one_of(cls, data):
        value = data.get("value")
        use_env_value = data.get("use_env_value", False)
        description = data.get("description")
        if not value and not use_env_value and not description:
            raise ValueError("At least one of 'value', 'use_env_value', or 'description' must be provided")
        return data


class EnvVarApiInfoOut(EnvVarApiInfo):
    visible_value: Optional[str] = None
    key_id: Optional[str] = None


class EnvVarInfo(BaseModel):
    var_name: Optional[str] = None
    data: Optional[EnvVarApiInfo] = None
    target_entity_typeid: TypeId
    var_type_filter: Optional[list[EnvVarType]] = None


@action.all(action_name="env-var")
async def handle_env_var_request(request: Request) -> ApiResponse:
    request_info = get_current_request_info()
    if request_info.sub_path == "table":
        return await get_env_vars_table_action()

    env_var_info = await build_env_var_info(request)

    method = request.method.upper()
    if method == "POST":
        return await create_env_var(env_var_info)
    if method == "PUT":
        return await update_env_var(env_var_info)
    if method == "DELETE":
        return await delete_env_var(env_var_info)
    if method == "GET":
        if env_var_info.var_name:
            return await get_env_var(env_var_info)
        else:
            return await get_env_vars_list(env_var_info)

    return ApiFailResponse(message=f"Action env-var is not allowed for {method}")


async def build_env_var_info(request: Request) -> EnvVarInfo:
    request_info = get_current_request_info()
    if not request_info or not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="request info not available")

    method = request.method.upper()
    var_name = request_info.sub_path
    data = None
    var_type_filter = None

    if method == "GET" and not var_name:
        query_params = dict(request.query_params)
        if "var_type" in query_params:
            type_strings = query_params["var_type"].split(",")
            try:
                var_type_filter = [EnvVarType(t.strip()) for t in type_strings]
            except ValueError as e:
                raise HTTPException(status_code=400, detail=f"Invalid var_type: {e}")

    if method in {"POST", "PUT"}:
        body = await request_info.get_post_data()
        if not body:
            raise HTTPException(status_code=400, detail="env var data not provided")

        if method == "PUT":
            if not var_name:
                raise HTTPException(status_code=400, detail="env var name not provided in path")
            body["name"] = var_name

        try:
            data = EnvVarApiInfoIn.model_validate(body)
        except ValidationError as e:
            raise HTTPException(status_code=400, detail=str(e))

    return EnvVarInfo(
        var_name=var_name,
        data=data,
        target_entity_typeid=request_info.target_entity_typeid,
        var_type_filter=var_type_filter,
    )


async def get_env_vars_list(env_var_info: EnvVarInfo) -> ApiResponse[list[EnvVarApiInfoOut]]:
    target_entity: Entity = await Entity.get_by_typeid(env_var_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    if target_entity.env_vars is None:
        return ApiSuccessResponse(data=[])

    env_vars = target_entity.env_vars.values

    if env_var_info.var_type_filter:
        env_vars = [ev for ev in env_vars if ev.var_type in env_var_info.var_type_filter]

    result = [
        EnvVarApiInfoOut(
            name=ev.name,
            var_type=ev.var_type,
            description=ev.description,
            visible_value=ev.visible_value,
            key_id=ev.key_id,
        )
        for ev in env_vars
    ]

    return ApiSuccessResponse(data=result)


async def get_env_var(env_var_info: EnvVarInfo) -> ApiResponse[EnvVarApiInfoOut]:
    if not env_var_info.var_name:
        raise HTTPException(status_code=400, detail="env var name not provided")

    var_name = env_var_info.var_name
    validate_env_var_name(var_name)

    target_entity: Entity = await Entity.get_by_typeid(env_var_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    if target_entity.env_vars is None:
        raise HTTPException(status_code=404, detail="env var not found")

    entity_var = next((ev for ev in target_entity.env_vars.values if ev.name == var_name), None)
    if not entity_var:
        raise HTTPException(status_code=404, detail="env var not found")

    result = EnvVarApiInfoOut(
        name=entity_var.name,
        var_type=entity_var.var_type,
        description=entity_var.description,
        visible_value=entity_var.visible_value,
    )

    return ApiSuccessResponse(data=result)


async def create_env_var(env_var_info: EnvVarInfo) -> ApiResponse[EnvVarApiInfoOut]:
    env_var_api_info = env_var_info.data
    if not isinstance(env_var_api_info, EnvVarApiInfoIn):
        raise HTTPException(status_code=400, detail="Invalid env var API info")

    var_name = env_var_api_info.name
    var_value = env_var_api_info.value
    var_type = env_var_api_info.var_type
    var_description = env_var_api_info.description
    use_env_value = env_var_api_info.use_env_value

    target_entity = await Entity.get_by_typeid(env_var_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    if use_env_value:
        var_value = os.getenv(var_name)
        if not var_value:
            raise HTTPException(
                status_code=404, detail=f"Environment variable '{var_name}' not found in OS environment"
            )

    if not var_name or not var_value:
        raise HTTPException(status_code=400, detail="env var name and value are required")

    entity_var = await add_env_var_to_entity(
        entity=target_entity,
        name=var_name,
        var_type=var_type,
        description=var_description,
        value=var_value,
        skip_if_exists=False,
    )

    created_var = EnvVarApiInfoOut(
        name=entity_var.name,
        var_type=entity_var.var_type,
        description=entity_var.description,
        visible_value=entity_var.visible_value,
    )
    return ApiSuccessResponse(data=created_var)


async def update_env_var(env_var_info: EnvVarInfo) -> ApiResponse[EnvVarApiInfoOut]:
    var_name = env_var_info.var_name
    if not var_name:
        raise HTTPException(status_code=400, detail="env var name not provided")

    target_entity: Entity = await Entity.get_by_typeid(env_var_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    if target_entity.env_vars is None:
        raise HTTPException(status_code=404, detail="env var not found")

    entity_var = next((ev for ev in target_entity.env_vars.values if ev.name == var_name), None)
    if not entity_var:
        raise HTTPException(status_code=404, detail="env var not found")

    env_var_api_info = env_var_info.data
    if not env_var_api_info or not isinstance(env_var_api_info, EnvVarApiInfoIn):
        raise HTTPException(status_code=400, detail="env var data not provided")

    # Prevent value updates for env_vars with key_id (API keys)
    if env_var_api_info.value and entity_var.has_key_id():
        raise HTTPException(
            status_code=400,
            detail="Cannot update value for API key. API keys are immutable. Use the api-keys action to manage API keys.",
        )

    if env_var_api_info.value:
        await store_env_var_value(entity_var, env_var_api_info.value, target_entity.typeid)

    if env_var_api_info.description is not None:
        entity_var.description = env_var_api_info.description

    await target_entity.update()

    updated_var = EnvVarApiInfoOut(
        name=entity_var.name,
        var_type=entity_var.var_type,
        description=entity_var.description,
        visible_value=entity_var.visible_value,
    )
    return ApiSuccessResponse(data=updated_var)


async def delete_env_var(env_var_info: EnvVarInfo) -> ApiResponse:
    if not env_var_info.var_name:
        raise HTTPException(status_code=400, detail="env var name not provided")

    target_entity: Entity = await Entity.get_by_typeid(env_var_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    var_name = env_var_info.var_name
    validate_env_var_name(var_name)

    if target_entity.env_vars is None:
        raise HTTPException(status_code=404, detail="env vars not found")

    entity_var = target_entity.get_env_var(var_name)
    if not entity_var:
        raise HTTPException(status_code=404, detail="env var not found")

    # Drop the stored value only when THIS entity owns it — a borrowed
    # reference (a project row pointing at a user's token) must leave the
    # owner's secret intact.
    await delete_env_var_value(entity_var, target_entity)

    target_entity.remove_env_var(var_name)
    await target_entity.update()

    return ApiSuccessResponse(message="Env var deleted successfully")


async def get_env_vars_table_action() -> ApiSuccessResponse:
    """Get env vars table. Simplified for local mode (no OAuth providers)."""
    from flow_sdk.core.entity.entity_env.env_table import merge_env_tables

    request_info = get_current_request_info()
    if not request_info:
        raise HTTPException(status_code=401, detail="Unauthorized: request info required")

    user = request_info.user
    if not user:
        raise HTTPException(status_code=401, detail="Unauthorized: user required")

    if not request_info.target_entity_typeid:
        raise HTTPException(status_code=400, detail="Target entity not found")

    target_entity: Entity = await Entity.get_by_typeid(request_info.target_entity_typeid)
    if not target_entity:
        raise HTTPException(status_code=400, detail="Target entity not found")

    if target_entity.type == BuiltinEntityType.USER.value:
        # A USER's table IS the provider table: one value-free OAUTH_PROVIDER_ID
        # row per provider, merged against the user's own credentials for
        # status. Returning an empty list here is why the Connections tab
        # rendered nothing.
        from flow_sdk.core.oauth import get_oauth_providers_as_env_table  # noqa: PLC0415

        return ApiSuccessResponse(data=await get_oauth_providers_as_env_table(target_entity))
    else:
        user_table = user.env_vars or EntityEnvVars(values=[])
        project_table = target_entity.env_vars or EntityEnvVars(values=[])
        env_vars_status_table = merge_env_tables(project_table, user_table, base_entity_typeid=target_entity.typeid)
        return ApiSuccessResponse(data=env_vars_status_table)
