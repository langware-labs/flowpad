"""Side-effect module: import every indexer-function module to register their
TypeInfo + walkers on ``SchemaRegistry``.

Callers that previously imported ``flow_sdk.fs_records`` for its registration
side-effects should import this module instead.
"""
# Walker modules — register TypeInfo + folder walkers.
import flow_sdk.fs_store.indexer.functions.agent  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_command  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_hook  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_md  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_memory  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_plan  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_projects  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_rules  # noqa: F401
import flow_sdk.fs_store.indexer.functions.claude_sessions  # noqa: F401
import flow_sdk.fs_store.indexer.functions.codex_sessions  # noqa: F401
import flow_sdk.fs_store.indexer.functions.copilot_sessions  # noqa: F401
import flow_sdk.fs_store.indexer.functions.dataset  # noqa: F401
import flow_sdk.fs_store.indexer.functions.markdown  # noqa: F401
import flow_sdk.fs_store.indexer.functions.markdown_index  # noqa: F401
import flow_sdk.fs_store.indexer.functions.mcp_server  # noqa: F401
import flow_sdk.fs_store.indexer.functions.plugin  # noqa: F401
import flow_sdk.fs_store.indexer.functions.skill  # noqa: F401
import flow_sdk.fs_store.indexer.functions.todo  # noqa: F401
import flow_sdk.fs_store.indexer.functions.spec  # noqa: F401
import flow_sdk.fs_store.indexer.functions.task  # noqa: F401
import flow_sdk.fs_store.indexer.functions.whiteboard  # noqa: F401
import flow_sdk.fs_store.indexer.functions.workflow  # noqa: F401
# Operations modules — register types that have no walker but are CRUD-able.
import flow_sdk.fs_store.operations.claude_debug_log  # noqa: F401
import flow_sdk.fs_store.operations.claude_error  # noqa: F401
import flow_sdk.fs_store.operations.cli_log  # noqa: F401

# Entity modules — trigger Entity.__init_subclass__ → SchemaRegistry merge of entity_cls.
import flow_sdk.builtin.agent  # noqa: F401
import flow_sdk.builtin.claude_memory_entities  # noqa: F401
import flow_sdk.builtin.claude_session  # noqa: F401
import flow_sdk.builtin.codex_session  # noqa: F401
import flow_sdk.builtin.copilot_session  # noqa: F401
import flow_sdk.builtin.command  # noqa: F401
import flow_sdk.builtin.dataset  # noqa: F401
import flow_sdk.builtin.markdown_index  # noqa: F401
import flow_sdk.builtin.project  # noqa: F401
import flow_sdk.builtin.skill  # noqa: F401
import flow_sdk.builtin.task  # noqa: F401
import flow_sdk.builtin.whiteboard  # noqa: F401
import flow_sdk.builtin.workflow  # noqa: F401

# Per-type metadata definitions (schema/type_info/<type>_info.py) — the single
# authoring home for TypeInfo. Registered after entities so entity_cls merges in.
from flow_sdk.schema.type_info import register_all as _register_type_info  # noqa: E402

_register_type_info()
