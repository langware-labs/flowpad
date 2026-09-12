"""Filesystem contracts independent of application entities."""
from __future__ import annotations

import json
from pathlib import Path

from flow_sdk.fs_store.fs_ref import FSRef


def credential_spec_identity_key(ref: "FSRef | Path") -> str:
    """The spec's ``name`` — its instance-global natural key.

    NOT the path, for the reason ``data_source_spec_identity_key`` documents and
    paid for: a spec SHIPS inside the wheel, so its absolute path names the
    INSTALL (`.../uv/tools/flowpad/Lib/site-packages/...`), not the asset. It
    differs between install methods, several coexist on one machine, and it
    changes on every upgrade — so keying identity on it forks one shipped
    credential into a row per install location, which a picker then renders as
    one button each (FLOWPAD-2070).

    ``name`` is the type's unique key everywhere else: it is the folder name by
    contract, and it is what a ``SecretOrigin.credential`` backref stores.

    Read from the manifest, which owns the value the row carries; the folder name
    is the fallback, and the two are one noun by contract.
    """
    path = Path(getattr(ref, "_path", ref))
    root = path.parent if path.is_file() else path
    try:
        manifest = json.loads((root / "credential.json").read_text(encoding="utf-8"))
        name = str(manifest.get("name") or "").strip()
    except (OSError, TypeError, json.JSONDecodeError):
        name = ""
    return name or root.name
