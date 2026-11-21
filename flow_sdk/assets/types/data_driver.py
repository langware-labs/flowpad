"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from pathlib import Path

from flow_sdk.assets.types.named_manifest import name_identity_key
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.schema.data_spec.data_driver_spec import AGENT_FILE, SCRIPT_FILE, DataDriverSpec


def derive_data_driver(data: dict, root: Path, header_raw: dict) -> None:
    """The runtime the folder implies — a fact the manifest alone cannot state. Only the retired
    runtimes' marker names are stat'ed: listing the folder cost one syscall per entry for a source
    that vendors helper modules."""
    markers = {name for name in (SCRIPT_FILE, AGENT_FILE) if (root / name).is_file()}
    data["runtime"] = DataDriverSpec.model_validate(header_raw).runtime_for_folder(markers).value


def data_driver_identity_key(ref: "FSRef | Path") -> str:
    """The spec's ``name`` — its instance-global natural key.

    NOT the path. A spec SHIPS inside the wheel, so its absolute path names the
    install (`…/uv/tools/flowpad/Lib/site-packages/…`), not the asset: it differs
    between install methods, several coexist on one machine, and it changes on
    every upgrade. Keying identity on it forked one shipped source into a row per
    install location, which the provider picker rendered as one button each.

    ``name`` is already the type's unique key everywhere else — the source
    registry is keyed by it (`ingest/driver_registry.py`),
    `DataSource` resolves its spec with ``get_one({"name": provider})``, and the
    dialog keys its lookup map by it. Identity just agrees with that now.

    Read from the manifest, which owns the value the row carries; the folder name
    is the fallback, and the two are one noun by contract (``DataDriverSpec.name``:
    "the registry key AND the folder name").
    """
    return name_identity_key(DataDriverSpec.main_file)(ref)
