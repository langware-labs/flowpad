"""Kind resolution — the ONLY module here that consults ``SchemaRegistry``.

``spec.py`` must stay importable from ``flow_sdk/builtin/*`` with no cycle, so
the registry import is deferred into the function.

Resolution order for a kind:
  1. a reserved PRIMITIVE  -> its Python type
  2. a registered kind     -> its class
  3. anything else         -> ``Any`` — anonymous: legal, opaque, never minted

A kind that references itself while being parsed resolves to ``Any`` (it is
not registered yet). Compilation is eager, so that is the whole story — no
cycle detection is needed, and none is done.
"""

from __future__ import annotations

from typing import Any

PRIMITIVES: dict[str, type] = {"string": str, "int": int, "float": float, "bool": bool}
PRIMITIVE_NAMES: dict[type, str] = {py: name for name, py in PRIMITIVES.items()}


def resolve_kind(kind: str) -> Any:
    prim = PRIMITIVES.get(kind)
    if prim is not None:
        return prim
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # lazy: avoid import cycle

    shape = SchemaRegistry.kind_type(kind)
    return Any if shape is None else shape


def register_builtin_kinds() -> None:
    """Bind the kinds the SDK itself vouches for. ``fs_ref`` is the shape of a
    capability's folder value (an FSRef dict). Importing ``dataset_spec``
    registers ``file_ref`` / ``folder`` / ``text`` for a process that never
    touched a dataset."""
    from flow_sdk.fs_store.fs_ref import FSRef  # lazy
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # lazy

    SchemaRegistry.register_kind("fs_ref", FSRef)
    import flow_sdk.schema.data_spec.activity_spec  # noqa: F401  — registers ``activity.progress`` / ``activity.error``
    import flow_sdk.schema.data_spec.agent_spec  # noqa: F401  — registers ``agent.place``
    import flow_sdk.schema.data_spec.channel_spec  # noqa: F401  — registers ``conversation.channel``
    import flow_sdk.schema.data_spec.choice_spec  # noqa: F401  — registers ``ingest.choice`` / ``ingest.choice_set``
    import flow_sdk.schema.data_spec.compute_op_spec  # noqa: F401  — registers ``compute_op`` / ``compute_op.command`` / ``compute_op.attempt``
    import flow_sdk.schema.data_spec.connection_spec  # noqa: F401  — registers ``connection``
    import flow_sdk.schema.data_spec.dataset_spec  # noqa: F401  — self-registering leaves
    import flow_sdk.schema.data_spec.folder_change_spec  # noqa: F401  — registers ``ingest.folder_change``
    import flow_sdk.schema.data_spec.icon_spec  # noqa: F401  — registers ``icon`` / ``icon.pack``
    import flow_sdk.schema.data_spec.llm_source_spec  # noqa: F401  — registers ``llm.source``
    import flow_sdk.schema.data_spec.mcp_spec  # noqa: F401  — registers ``mcp.server``
    import flow_sdk.schema.data_spec.message_sender_spec  # noqa: F401  — registers ``message.sender``
    import flow_sdk.schema.data_spec.phone_spec  # noqa: F401  — registers ``phone_number``
    import flow_sdk.schema.data_spec.project_cleanup_spec  # noqa: F401  — registers ``project.cleanup`` and friends
    import flow_sdk.schema.data_spec.project_manifest_spec  # noqa: F401  — registers ``project.manifest`` / ``project.manifest.entry``
    import flow_sdk.schema.data_spec.rag_spec  # noqa: F401  — registers ``rag.chunk`` / ``rag.hit``
    import flow_sdk.schema.data_spec.runtime_info_spec  # noqa: F401 — registers ``runtime.info``
    import flow_sdk.schema.data_spec.returned_value_spec  # noqa: F401  — registers ``compute.returned``
    import flow_sdk.schema.data_spec.session_spec  # noqa: F401  — registers ``session.start``
    import flow_sdk.schema.data_spec.source_item_spec  # noqa: F401  — registers ``ingest.source_item``
    import flow_sdk.schema.data_spec.trigger_spec  # noqa: F401  — registers ``trigger`` / ``trigger.tag`` / ``trigger.schedule`` / ``trigger.watch`` / ``trigger.hook`` / ``trigger.action``
    import flow_sdk.schema.data_spec.wizard_spec  # noqa: F401  — registers ``wizard`` / ``wizard.step`` / ``wizard.input`` / ``wizard.outcome`` / ``wizard.awaiting`` / ``wizard.probe`` / ``wizard.issue`` / ``wizard.validation`` / ``wizard.run_detail``
    import flow_sdk.secrets  # noqa: F401  — registers ``secrets.store_ref`` / ``secrets.vault``
    import flow_sdk.sources.values  # noqa: F401  — registers ``source.*`` and ``ingest.file`` / ``ingest.profile`` / ``ingest.message``
    # A data source asset defines its own payload kinds (``ingest.message.whatsapp``) in code the
    # registry loads lazily; a row read before any source ran still restores its payload. Imported
    # only on a miss, so registering the loader drags nothing in.
    SchemaRegistry.add_kind_loader("ingest.", _load_source_value_kinds)


def _load_source_value_kinds() -> None:
    from flow_sdk.ingest.driver_registry import load_driver_value_kinds  # noqa: PLC0415

    load_driver_value_kinds()
