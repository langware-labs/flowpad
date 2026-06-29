"""CLI log settings registration — no Record subclass.

The CLI invocation log lives as JSONL (see ``flow_sdk/cli/cli_log.py``) and its
settings live in an ``FSRecord(type='cli_log_settings', id='local')`` shadow.
The backend CLI path reads/writes that shadow via ``FSRecord`` directly, but the
UI's account settings panel goes through the generic ``fs-records`` route, which
gates on ``SchemaRegistry``. Register the type as CRUD-only (no walker) so that
route accepts it instead of returning a 400 "Unknown record type".
"""

from __future__ import annotations

from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.fs_store.schema_registry import SchemaRegistry

# CRUD-only type (no walker): the cli_log_settings/local shadow is read/written
# on demand by the account settings UI via the fs-records route.
SchemaRegistry.register_crud_type(RecordType.CLI_LOG_SETTINGS, icon="Settings")
