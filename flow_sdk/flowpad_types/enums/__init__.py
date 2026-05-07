"""
Core enums package - centralized enum definitions to avoid circular imports.

This package contains all core enums organized by area:
- auth_enums: Authentication and authorization enums
- entity_enums: Entity and relationship enums
- worker_enums: Worker and task execution enums
"""

import uuid

# Re-export auth enums
from flow_sdk.flowpad_types.enums.auth_enums import VISITOR_AUTH_ROLE, AuthRole, BuiltInConstant

# Re-export entity enums
from flow_sdk.flowpad_types.enums.entity_enums import (
    BuiltInRelationshipTypes,
    EnvOpType,
    ExpansionType,
    RelationshipDirection,
)

# Re-export process enums
from flow_sdk.flowpad_types.enums.process_enums import ProcessType

# Re-export trace enums
from flow_sdk.flowpad_types.enums.trace_enums import TraceLevel, TraceType

# Re-export worker enums
from flow_sdk.flowpad_types.enums.worker_enums import WorkerCapability, WorkerTaskStatus, WorkerType


def get_machine_id():
    return str(uuid.getnode())


__all__ = [
    # Auth enums
    "AuthRole",
    "BuiltInConstant",
    "VISITOR_AUTH_ROLE",
    # Entity enums
    "RelationshipDirection",
    "BuiltInRelationshipTypes",
    "ExpansionType",
    "EnvOpType",
    # Worker enums
    "WorkerType",
    "WorkerTaskStatus",
    "WorkerCapability",
    # Process enums
    "ProcessType",
    # Trace enums
    "TraceType",
    "TraceLevel",
    # Utilities
    "get_machine_id",
]
