from __future__ import annotations

import logging

from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.core.entity.entity_env.env_types import (
    EntityEnvVars,
    EnvStatusEnum,
    EnvVar,
    EnvVarStatus,
    EnvVarType,
)


def resolve_var_status(base_var: EnvVar, join_var: EnvVar, base_entity_typeid: TypeId = None) -> EnvStatusEnum:
    if base_var.is_oauth_provider:
        if join_var is None:
            return EnvStatusEnum.MISSING
        else:
            if join_var.var_type != EnvVarType.OAUTH_TOKEN:
                logging.warning(f"OAuth provider {base_var.name} has unexpected var_type {join_var.var_type}")
                return EnvStatusEnum.ERROR
            if base_var.ref_name == join_var.name:
                return EnvStatusEnum.AVAILABLE
            else:
                logging.warning(f"OAuth provider {base_var.name} has mismatched join var name {join_var.name}")
                return EnvStatusEnum.ERROR
    if base_var.is_ref:
        if join_var is None:
            return EnvStatusEnum.MISSING
        if base_entity_typeid:
            if join_var.is_allowed(base_entity_typeid):
                return EnvStatusEnum.AVAILABLE
            else:
                return EnvStatusEnum.CONSENT_REQUIRED
    if base_var.is_plain or base_var.is_key:
        if base_var.visible_value:
            return EnvStatusEnum.AVAILABLE
        else:
            return EnvStatusEnum.MISSING
    return EnvStatusEnum.NA


def get_ref_row(base_row: EnvVar, join_table: EntityEnvVars) -> EnvVar | None:
    if not base_row.is_ref:
        return None
    if not base_row.ref_name:
        logging.warning(f"REF variable {base_row.name} missing ref_name")
        return None

    for join_row in join_table.values:
        if join_row.name == base_row.ref_name:
            return join_row
    return None


def merge_env_tables(
    base_table: EntityEnvVars[EnvVar],
    join_table: EntityEnvVars[EnvVar],
    base_entity_typeid: TypeId = None,
) -> EntityEnvVars[EnvVarStatus]:
    merged_rows = []
    # Process only base table rows
    for base_row in base_table.values:
        join_row = get_ref_row(base_row, join_table)
        var_merge_status = resolve_var_status(base_row, join_row, base_entity_typeid)
        var_json = base_row.model_dump()
        status_var = EnvVarStatus.model_validate(var_json)
        status_var.var_status = var_merge_status
        merged_rows.append(status_var)
    merged = EntityEnvVars(values=merged_rows)
    return merged
