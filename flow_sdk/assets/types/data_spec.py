"""Indexing a ``data_spec`` folder IS registering the kind it defines."""

from __future__ import annotations

from pathlib import Path


def derive_data_spec(data: dict, root: Path, header_raw: dict) -> None:
    """Register the folder's kind and record the outcome on the row.

    ``subkind`` is the one the definition RESOLVES to (declared, else read from its body), so a
    list of data specs can say "record" without every author writing it. ``error`` is why the
    kind did not register -- a duplicate, a type name, a name nobody defines -- or ``""``.
    """
    from flow_sdk.schema.data_spec import declared  # noqa: PLC0415 — builds classes; keep off the import path

    data["error"] = declared.register_folder(root)
    data["subkind"] = declared.subkind_of(root)
