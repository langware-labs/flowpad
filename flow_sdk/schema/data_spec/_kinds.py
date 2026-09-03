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
    import flow_sdk.schema.data_spec.dataset_spec  # noqa: F401  — self-registering leaves
    import flow_sdk.schema.data_spec.llm_source_spec  # noqa: F401  — registers ``llm.source``
    import flow_sdk.schema.data_spec.mcp_spec  # noqa: F401  — registers ``mcp.server``
    import flow_sdk.schema.data_spec.rag_spec  # noqa: F401  — registers ``rag.chunk`` / ``rag.hit``
    import flow_sdk.schema.data_spec.source_item_spec  # noqa: F401  — registers ``ingest.source_item``
