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
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    pass

logger = logging.getLogger(__name__)
