"""Reader + extractor + asset-hash for WIZARD records.

A wizard is a folder containing ``wizard.json`` — an ordered list of steps,
each with a per-OS command precondition, an action, and a verify. Discovery is
the generic ``repo_assets_fn`` walk of ``<scope>/agentic-assets/wizard/*/``;
this module owns the reader, the extractor and the asset hash.

``read_wizard`` is the ONE reader. ``Wizard.spec()`` calls it too, so disk is
the single source of truth for what a wizard does — the row carries only what
a list needs (name, description, step count).

Nothing here raises. A malformed ``wizard.json`` in a cloned third-party repo
must degrade to "this folder declares no wizard", never wedge the indexer that
is walking a hundred other assets alongside it.
"""
from __future__ import annotations

from pathlib import Path
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import main_file_mtime

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

WIZARD_JSON = "wizard.json"


def read_wizard(wizard_dir: Path) -> Optional[WizardSpec]:
    """Parse ``<dir>/wizard.json`` into a ``WizardSpec``, or ``None``.

    Missing file, unreadable bytes, invalid JSON and a shape that fails
    validation all mean the same thing to every caller: this folder declares no
    wizard. ``ValidationError`` is a ``ValueError``, so the one except clause
    covers the parse and the validate alike.
    """
    try:
        return WizardSpec.model_validate_json((Path(wizard_dir) / WIZARD_JSON).read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return None


def wizard_asset_hash(ref: FSRef) -> float:
    """Freshness = the mtime of ``wizard.json``, and only that file.

    A wizard folder accumulates run scratch beside the document (the runner's
    workdir, a step's captured output); none of it changes what the wizard IS.
    """
    return main_file_mtime(ref, WIZARD_JSON)


def extract_wizard(ref: FSRef, resolved_id: str) -> list[FSRecord]:
    """Parse a wizard folder into one Record row."""
    path = ref._path
    spec = read_wizard(path) if path.is_dir() else None
    name = (spec.name if spec and spec.name else path.name)
    step_labels = " ".join(step.display_label for step in spec.steps) if spec else ""
    content = "\n".join(part for part in (name, spec.description if spec else "", step_labels) if part)

    rec_kwargs: dict = {
        "type": RecordType.WIZARD,
        "id": resolved_id,
        "name": name,
        "status": "active",
        "content": content,
    }
    if spec and spec.description:
        rec_kwargs["description"] = spec.description
    if spec:
        rec_kwargs["metadata"] = {
            "enabled": spec.enabled,
            "version": spec.version,
            "step_count": len(spec.steps),
            # Surfaced so a list can say "runs itself on X" without re-reading
            # the document, and so the trigger reconcile has a cheap prefilter.
            "trigger_tags": [trigger.on for trigger in spec.triggers],
        }
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
