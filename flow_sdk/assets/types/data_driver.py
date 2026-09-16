"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef


def derive_data_driver(data: dict, root: Path, header_raw: dict) -> None:
    """The runtime the folder implies — a fact the manifest alone cannot state. Only the retired
    runtimes' marker names are stat'ed: listing the folder cost one syscall per entry for a source
    that vendors helper modules."""
    from flow_sdk.schema.data_spec.data_driver_spec import AGENT_FILE, SCRIPT_FILE, DataDriverSpec

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
    registry is a flat dict keyed by it (`ingest/sources.py`),
    `DataSource` resolves its spec with ``get_one({"name": provider})``, and the
    dialog keys its lookup map by it. Identity just agrees with that now.

    Read from the manifest, which owns the value the row carries; the folder name
    is the fallback, and the two are one noun by contract (``DataDriverSpec.name``:
    "the registry key AND the folder name").
    """
    path = Path(getattr(ref, "_path", ref))
    root = path.parent if path.is_file() else path
    try:
        manifest = json.loads((root / "data_driver.json").read_text(encoding="utf-8"))
        name = str(manifest.get("name") or "").strip()
    except (OSError, TypeError, json.JSONDecodeError):
        name = ""
    return name or root.name
