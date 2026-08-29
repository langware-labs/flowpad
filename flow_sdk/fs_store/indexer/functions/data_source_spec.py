"""Extractor for DATA_SOURCE_SPEC — `agentic-assets/data_source/<name>/data_source.json`.

Thin by design: the manifest's shape and every rule about what it may say are
``ManifestSpec`` (``flow_sdk/builtin/data_source_spec.py``), loaded through the
type's serializer like any folder asset; the runtime is derived from the folder
by ``ManifestSpec.runtime_for_folder``. This module only does the walk-side plumbing.

A manifest that fails validation yields NO record rather than a half-parsed one.
A source that silently loaded with a dropped field is worse than one that is
visibly absent — the author gets a log line naming the rule they broke.
"""
from __future__ import annotations

import logging
from pathlib import Path

logger = logging.getLogger(__name__)


def derive_data_source_spec(data: dict, root: Path, header_raw: dict) -> None:
    """The runtime the folder's marker files imply — a fact the manifest alone
    cannot state. Only the two markers are stat'ed: listing the folder cost one
    syscall per entry for a source that vendors an implementation tree."""
    from flow_sdk.builtin.data_source_spec import DataSourceSpec, ManifestSpec  # noqa: PLC0415

    markers = {name for name in (DataSourceSpec.SCRIPT_FILE, DataSourceSpec.AGENT_FILE) if (root / name).is_file()}
    data["runtime"] = ManifestSpec.model_validate(header_raw).runtime_for_folder(markers).value
