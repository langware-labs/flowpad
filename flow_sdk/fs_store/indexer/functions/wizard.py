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
import logging
from typing import Optional

from flow_sdk.fs_store.indexer.functions._asset_identity import main_file_mtime

from flow_sdk.fs_store.fs_record import FSRecord
from flow_sdk.fs_store.fs_ref import FSRef
from flow_sdk.fs_store.record_types import RecordType
from pydantic import ValidationError

from flow_sdk.schema.data_spec.wizard_spec import WizardSpec

_log = logging.getLogger(__name__)

WIZARD_JSON = "wizard.json"


def parse_wizard(text: str) -> WizardSpec:
    """Parse a document, RAISING on anything wrong with it.

    The half of the reader that has an opinion. `read_wizard` keeps swallowing
    (it must — see below); this is what lets a caller that WANTS the error, like
    the validate action, get it.
    """
    return WizardSpec.model_validate_json(text)


#: ``path -> ((mtime_ns, size), spec, problem)``. Bounded by the number of
#: wizard assets on the machine — small, and not attacker-controlled — so it
#: needs no eviction policy. Same argument, and the same key, as ``read_state``'s
#: cache in ``core/wizard/state.py``.
_CACHE: "dict[str, tuple[tuple[int, int], Optional[WizardSpec], str]]" = {}


def read_wizard_result(wizard_dir: Path) -> "tuple[Optional[WizardSpec], str]":
    """``(spec, problem)`` from ONE read and ONE parse.

    The two questions a caller can ask about a wizard document — *what does it
    say* and *why is it not loading* — are answered by the same parse, so asking
    both must not cost two. `Wizard` asks both on every serialization: `agent`
    reads the spec and `document_error` the problem, and that rides every row of
    ``GET /graph/wizard`` and every WS entity push.

    Memoized on the document's ``(mtime_ns, size)``, because this sits on a
    SERIALIZATION path where a repeat call is now a single ``stat``. Size is part
    of the key as well as mtime because a coarse filesystem clock can leave two
    writes inside one tick. `WizardSpec` is frozen, so handing the same instance
    to every caller is safe.
    """
    path = Path(wizard_dir) / WIZARD_JSON
    try:
        stat = path.stat()
        stamp = (stat.st_mtime_ns, stat.st_size)
    except OSError:
        # Cache the ABSENCE too: a folder with no document is the common case on
        # a walk, and it is exactly the one the fast path would otherwise miss.
        stamp = (0, -1)

    hit = _CACHE.get(str(path))
    if hit is not None and hit[0] == stamp:
        return hit[1], hit[2]

    spec, problem = _parse_once(path)
    _CACHE[str(path)] = (stamp, spec, problem)
    return spec, problem


def _parse_once(path: Path) -> "tuple[Optional[WizardSpec], str]":
    """The single read+parse, turned into both answers."""
    try:
        return parse_wizard(path.read_text(encoding="utf-8")), ""
    except FileNotFoundError:
        return None, f"{WIZARD_JSON} is missing"
    except OSError as exc:
        return None, f"{WIZARD_JSON} could not be read: {exc}"
    except ValidationError as exc:
        first = exc.errors(include_url=False)[0]
        where = ".".join(str(part) for part in first.get("loc", ())) or "document"
        return None, f"{where}: {first.get('msg', 'is invalid')}"
    except ValueError as exc:
        return None, f"{WIZARD_JSON} is not valid JSON: {exc}"


def read_wizard(wizard_dir: Path) -> Optional[WizardSpec]:
    """Parse ``<dir>/wizard.json`` into a ``WizardSpec``, or ``None``.

    Missing file, unreadable bytes, invalid JSON and a shape that fails
    validation all mean the same thing to every caller: this folder declares no
    wizard. ``ValidationError`` is a ``ValueError``, so the one except clause
    covers the parse and the validate alike.

    The swallow STAYS, and is load-bearing in three places: the indexer walks a
    hundred assets in a repo someone cloned and one bad document must not wedge
    it; the extractor still emits a row for a broken folder, and that row is the
    only way to open and fix it; and `Wizard.spec()` callers all treat ``None``
    as a legible state. What it must not be is SILENT — that is
    `wizard_document_problem`, surfaced on the entity as `document_error`.
    """
    spec, problem = read_wizard_result(wizard_dir)
    if spec is None and problem:
        _log.debug("wizard document at %s did not parse: %s", wizard_dir, problem)
    return spec


def wizard_document_problem(wizard_dir: Path) -> str:
    """Why this folder declares no wizard, in one line, or ``""``.

    Without this, the most likely failure of an editor — "I saved it and my
    wizard disappeared" — is indistinguishable from "there was never a wizard
    here", at every surface in the product.
    """
    return read_wizard_result(wizard_dir)[1]


def document_warnings(spec: WizardSpec) -> "list[WizardIssueSpec]":
    """Advisory problems with a document that PARSES.

    Warnings, not errors, and deliberately: promoting either of these to a model
    validator would turn documents that load today into documents that vanish,
    in repos we do not control.

    Beside the parser rather than in the entity's action file: this is document
    semantics, so the indexer and a CLI can reach it too, not just one endpoint.
    """
    from flow_sdk.schema.data_spec.wizard_spec import WizardIssueSpec  # noqa: PLC0415

    issues: "list[WizardIssueSpec]" = []
    seen: dict[str, int] = {}
    for index, step in enumerate(spec.steps):
        if step.id in seen:
            issues.append(WizardIssueSpec(
                loc=["steps", index, "id"],
                msg=(f"duplicate step id {step.id!r} (also step {seen[step.id]}); "
                     "outcomes and live progress are keyed by id, so the two steps "
                     "report as one"),
                type="duplicate_id", severity="warning",
            ))
        else:
            seen[step.id] = index
    return issues


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
        }
    rec = FSRecord(**rec_kwargs)
    object.__setattr__(rec, "_asset_ref", FSRef(path.resolve()))
    return [rec]
