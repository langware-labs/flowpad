from __future__ import annotations

from pydantic import SecretStr

from flow_sdk import service_log
from flow_sdk.builtin.user import User
from flow_sdk.core import Entity
from flow_sdk.core.entity.entity_env.env_table import merge_env_tables
from flow_sdk.core.entity.entity_env.env_types import EnvStatusEnum, EnvVar, EnvVarType
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_entity_credentials, get_user_credentials


async def get_env_desc_context(project: Entity) -> list[EnvVar]:
    if project.env_vars is None:
        return []
    return project.env_vars.values


class FlowEnv(EnvVar):
    value: SecretStr

    def __init__(self, **kwargs):
        # Convert value to SecretStr if it's a plain string
        value = kwargs.get("value", "")
        if isinstance(value, str):
            kwargs["value"] = SecretStr(value)
        super().__init__(**kwargs)

    @classmethod
    def from_env_var(cls, env_var: EnvVar, value: str) -> "FlowEnv":
        flow_env = cls.model_construct(
            name=env_var.name,
            var_type=env_var.var_type,
            description=env_var.description,
            visible_value=env_var.visible_value,
            allowed_to_use=env_var.allowed_to_use,
            ref_type=env_var.ref_type,
            ref_name=env_var.ref_name,
            value=SecretStr(value),
        )
        return flow_env


async def get_env_vars_context(user: User, project: Entity) -> list[FlowEnv]:
    from flow_sdk.core.entity.entity_env.env_types import EntityEnvVars

    env_vars = []
    user_table = user.env_vars or EntityEnvVars[EnvVar]()
    project_table = project.env_vars or EntityEnvVars[EnvVar]()

    # Merge project table with user table for project-level env vars
    merged_table = merge_env_tables(project_table, user_table, base_entity_typeid=project.typeid)
    for env_var in merged_table.values:
        if env_var.var_status == EnvStatusEnum.AVAILABLE:
            value = None
            try:
                if env_var.ref_type == BuiltinEntityType.USER:
                    if env_var.ref_name:
                        value = await get_user_credentials(user, env_var.ref_name, None)
                elif env_var.ref_type is None:
                    if env_var.var_type == EnvVarType.PLAIN.value:
                        value = env_var.visible_value
                    else:
                        value = await get_entity_credentials(project, env_var.name)
                else:
                    service_log.error(f"Unsupported ref_type {env_var.ref_type} for env var {env_var.name}")

            except Exception as e:
                service_log.error(f"Error getting env var credentials for {env_var.name}: {e}")

            if value is None:
                continue
            flow_env = FlowEnv.from_env_var(env_var, value)
            env_vars.append(flow_env)

    # Also include OAuth tokens and API keys stored directly on user (e.g., CLAUDE_CODE_OAUTH_TOKEN, ANTHROPIC_API_KEY for desktop)
    # Check user's env vars directly for OAuth tokens and API keys instead of relying on OAuth provider ref_name
    # This handles cases where desktop mode uses different token names (e.g., CLAUDE_CODE_OAUTH_TOKEN)
    if user_table:
        for user_env_var in user_table.values:
            # Include OAuth tokens and API keys stored on user with ref_type=USER
            if user_env_var.ref_type == BuiltinEntityType.USER and user_env_var.var_type in [
                EnvVarType.OAUTH_TOKEN,
                EnvVarType.API_KEY,
            ]:
                # Check if we already included this via the merged table
                already_included = any(ev.name == user_env_var.name for ev in env_vars)
                if not already_included:
                    # Get the token/key directly from user using ref_name or name
                    token_name = user_env_var.ref_name or user_env_var.name
                    value = None
                    try:
                        var_type_str = "OAuth token" if user_env_var.var_type == EnvVarType.OAUTH_TOKEN else "API key"
                        service_log.info(
                            f"#### Getting {var_type_str} {token_name} from user (env var name: {user_env_var.name}) ####"
                        )
                        value = await get_user_credentials(user, token_name, None)
                        if value:
                            service_log.info(f"#### Found {var_type_str} {token_name} (prefix: {value[:20]}...) ####")
                            flow_env = FlowEnv.from_env_var(user_env_var, value)
                            env_vars.append(flow_env)
                            service_log.info(f"#### Added {var_type_str} {user_env_var.name} to env_vars ####")
                        else:
                            service_log.warning(f"#### {var_type_str} {token_name} value is None ####")
                    except Exception as e:
                        service_log.error(f"Error getting {var_type_str} {token_name} from user: {e}")
                        import logging

                        logging.exception(f"Error getting {var_type_str} {token_name} from user")

    return env_vars


async def resolve_node_secret_env(project) -> list[FlowEnv]:
    """The project's ATTACHED secrets, as FlowEnv for a compute node.

    The node-side half of the same resolution the worker path uses — one
    resolver, two transports (see ``secret_origin_resolver``). Values ride the
    per-command prefix and are never written to the node's filesystem; ``set_env``
    stays reserved for the FLOWPAD_* proxy config.
    """
    from flow_sdk.builtin.secret_origin_resolver import (  # noqa: PLC0415
        attached_env_vars_for,
        resolve_project_secrets,
    )

    if project is None:
        return []
    only = await attached_env_vars_for(project)
    resolved = await resolve_project_secrets(project, only=only)
    return [
        FlowEnv.model_construct(name=name, var_type=EnvVarType.API_KEY, value=value)
        for name, value in resolved.items()
    ]
