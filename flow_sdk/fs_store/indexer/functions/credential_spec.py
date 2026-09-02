"""Identity for CREDENTIAL_SPEC — `agentic-assets/credential/<name>/credential.json`.

Thin by design, and thinner than its ``data_source_spec`` sibling: the manifest's
shape and every authoring rule are ``CredentialManifestSpec``
(``flow_sdk/builtin/credential_spec.py``), loaded through the type's serializer
like any folder asset's main document. There is no ``derive_fields_fn`` here
because a credential folder has no marker files — nothing about it is derived
from the listing, so the manifest alone is the whole truth.

What remains is the one thing the type genuinely cannot do without.
"""
from __future__ import annotations

import json
from pathlib import Path
from typing import TYPE_CHECKING

if TYPE_CHECKING:
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
