"""Kinds DEFINED BY A FOLDER: build ``data_spec/<full.kind>/data_spec.json`` into a registered DataSpec.

The ontology's other path mints a kind by importing code (``driver_registry``: a data driver's
``source.py``). This one builds the class from the folder's document, and then registers it
through the SAME hook every hand-written spec uses -- ``DataSpec.__pydantic_init_subclass__``
inside ``_namespace.loading(ns)`` -- so the namespace, ``__spec_tag__`` and "a kind names exactly
one shape" all apply unchanged. One mechanism, two ways to hand it a class.

**Dependencies build first.** A shape refers to other kinds by name, and the registry answers an
unknown name with ``Any`` -- silently. So every folder is first recorded as PENDING, and building
one builds the pending kinds it names before compiling itself; a name that still resolves to
``Any`` afterwards is an error, never a field that accepts anything. That makes nesting and
sibling order irrelevant: a parent may name its children, a child its sibling.

**A failure is recorded, never raised.** A duplicate kind, a kind that is a type name, a name
nobody defines -- each becomes the folder's ``error``, which indexing writes onto the row.

Namespace, as for a data driver: what we ship is ours (bare); otherwise the document's ``ns``,
else its project's; an external that names none is refused, or its kinds would land in ours.
"""

from __future__ import annotations

import json
import logging
import re
import threading
from pathlib import Path
from typing import Any, ClassVar, Optional, get_args

from pydantic import Field, ValidationError, create_model

from flow_sdk.schema.data_spec._namespace import loading, qualified
from flow_sdk.schema.data_spec.data_spec_spec import DataSpecDocSpec
from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, ExampleSpec
from flow_sdk.schema.data_spec.spec import ENUM_PREFIX, OPTIONAL_MARK, DataSpec, _compile, _normalize_form

logger = logging.getLogger(__name__)

MAIN = "data_spec.json"
FAMILY = "data_spec"
ASSETS_DIR = "agentic-assets"

_lock = threading.RLock()
#: qualified kind -> the folder defining it, not yet built.
_PENDING: dict[str, Path] = {}
#: qualified kind -> the folder that defined it (a second folder for the same kind is an error).
_OWNER: dict[str, Path] = {}
#: folder -> why it did not register ("" when it did, or when it is a documentation node).
_ERRORS: dict[Path, str] = {}
_BUILDING: set[str] = set()
_shipped_loaded = False


class DeclareError(ValueError):
    """Why a data spec folder did not register."""


# ── finding folders ──────────────────────────────────────────────────────────


def data_spec_folders(root: Path) -> list[Path]:
    """Every data spec folder under ``root``'s ``agentic-assets/``, at any depth of nesting.

    Walks only ``agentic-assets`` trees -- an asset's own children live there -- so a project
    root costs a few directory listings, never a crawl of its sources.
    """
    out: list[Path] = []

    def walk(container: Path) -> None:
        assets = container / ASSETS_DIR
        if not assets.is_dir():
            return
        for family in sorted(p for p in assets.iterdir() if p.is_dir()):
            for asset in sorted(p for p in family.iterdir() if p.is_dir()):
                if family.name == FAMILY and (asset / MAIN).is_file():
                    out.append(asset)
                walk(asset)

    walk(Path(root))
    return out


def _is_shipped(folder: Path) -> bool:
    from flow_sdk.config import system_projects_root  # noqa: PLC0415

    try:
        Path(folder).resolve().relative_to(system_projects_root().resolve())
        return True
    except ValueError:
        return False


def _read(folder: Path) -> DataSpecDocSpec:
    try:
        raw = json.loads((folder / MAIN).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DeclareError(f"{MAIN} is unreadable: {exc}") from exc
    try:
        return DataSpecDocSpec.model_validate(raw)
    except ValidationError as exc:
        raise DeclareError(f"{MAIN} is not a data spec: {exc.errors()[0].get('msg', exc)}") from exc


def namespace_of(folder: Path, doc: DataSpecDocSpec) -> str:
    """Whose ontology the folder's kind belongs to: ours if shipped, else declared or inherited."""
    if _is_shipped(folder):
        return ""
    from flow_sdk.assets.project_manifest import namespace_for  # noqa: PLC0415 — the layer that owns manifests

    ns = doc.ns or namespace_for(folder)
    if not ns:
        raise DeclareError(
            "declares no `ns`: an externally authored data spec must name the ontology namespace "
            "its kind belongs to, or it lands in ours"
        )
    return ns


def kind_of(folder: Path) -> str:
    """The kind a folder defines: its name, the full dot path (never relative to its parent)."""
    return Path(folder).name


# ── building ─────────────────────────────────────────────────────────────────


def _refs(form: Any) -> list[str]:
    """The kind names a form refers to (``?`` stripped; enums and primitives are not kinds)."""
    from flow_sdk.schema.data_spec._kinds import PRIMITIVES  # noqa: PLC0415

    if isinstance(form, str):
        name = form[len(OPTIONAL_MARK) :] if form.startswith(OPTIONAL_MARK) else form
        return [] if name.startswith(ENUM_PREFIX) or name in PRIMITIVES else [name]
    if isinstance(form, list):
        return [r for item in form for r in _refs(item)]
    if isinstance(form, dict):
        return [r for child in form.values() for r in _refs(child)]
    return []


def _qualify(form: Any, ns: str) -> Any:
    """Bare names of kinds defined in the SAME namespace, written as their registered tag.

    An author in project ``acme`` writes ``navigator.request`` for a sibling; the registry knows it
    as ``--acme--.navigator.request``. The tag a form carries must be the key registered, so the
    rewrite happens here, once, for names this namespace actually defines.
    """
    if not ns:
        return form
    if isinstance(form, str):
        opt = form.startswith(OPTIONAL_MARK)
        name = form[1:] if opt else form
        q = qualified(name, ns)
        if q in _PENDING or q in _OWNER:
            return (OPTIONAL_MARK if opt else "") + q
        return form
    if isinstance(form, list):
        return [_qualify(item, ns) for item in form]
    if isinstance(form, dict):
        return {k: _qualify(v, ns) for k, v in form.items()}
    return form


def _contains_any(annotation: Any) -> bool:
    if annotation is Any:
        return True
    return any(_contains_any(arg) for arg in get_args(annotation))


def _class_name(kind: str) -> str:
    return "Declared_" + re.sub(r"\W", "_", kind)


def _field(form: Any, description: str) -> tuple:
    from flow_sdk.schema.data_spec.spec import _field_def  # noqa: PLC0415

    annotation, default = _field_def(form)
    return (annotation, Field(default, description=description or None))


def _build(folder: Path) -> Optional[type]:
    """Compile and register ONE folder; dependencies first. Raises ``DeclareError``."""
    doc = _read(folder)
    subkind = doc.resolved_subkind
    if subkind is None:
        return None  # a documentation node: it names no shape, so it registers nothing
    ns = namespace_of(folder, doc)
    kind = kind_of(folder)
    tag = qualified(kind, ns)
    owner = _OWNER.get(tag)
    if owner is not None and owner.resolve() != folder.resolve():
        raise DeclareError(f"kind {tag!r} is already defined by {owner}")

    if subkind == "record":
        forms = {name: _normalize_form(f.shape) for name, f in (doc.fields or {}).items()}
    else:
        forms = {slot: _normalize_form(form) for slot, form in (doc.examples or {}).items()}
    forms = {name: _qualify(form, ns) for name, form in forms.items()}

    # Build what this one names before compiling it, so no reference resolves to Any.
    for ref in {r for form in forms.values() for r in _refs(form)}:
        if ref in _BUILDING:
            raise DeclareError(f"kind {tag!r} and {ref!r} refer to each other")
        if ref in _PENDING:
            _build_pending(ref)

    _BUILDING.add(tag)
    try:
        with loading(ns):
            if subkind == "record":
                fields = {name: _field(form, (doc.fields or {})[name].description) for name, form in forms.items()}
                for name, (annotation, _default) in fields.items():
                    if _contains_any(annotation):
                        raise DeclareError(f"field {name!r} names a kind nobody defines: {forms[name]!r}")
                cls = create_model(  # type: ignore[call-overload]
                    _class_name(tag),
                    __base__=DataSpec,
                    __module__=__name__,
                    __doc__=str(doc.description or "") or None,
                    spec_kind=(ClassVar[str], kind),
                    **fields,
                )
            else:
                slots = {slot: _compile(form) for slot, form in forms.items()}
                for slot, shape in slots.items():
                    if _contains_any(shape):
                        raise DeclareError(f"slot {slot!r} names a kind nobody defines: {forms[slot]!r}")
                example = ExampleSpec[  # type: ignore[valid-type]
                    slots["input"], slots.get("output", DataSpec), slots.get("context", DataSpec)
                ]
                cls = create_model(  # type: ignore[call-overload]
                    _class_name(tag),
                    __base__=DatasetSpec[example],  # type: ignore[valid-type]
                    __module__=__name__,
                    __doc__=str(doc.description or "") or None,
                    spec_kind=(ClassVar[str], kind),
                )
    except DeclareError:
        raise
    except (ValueError, TypeError) as exc:  # the registry refusing (a type name, a code-defined kind)
        raise DeclareError(str(exc)) from exc
    finally:
        _BUILDING.discard(tag)
    _OWNER[tag] = folder
    return cls


def _build_pending(tag: str) -> None:
    folder = _PENDING.pop(tag)
    try:
        _build(folder)
        _ERRORS[folder] = ""
    except DeclareError as exc:
        _ERRORS[folder] = str(exc)
        logger.warning("[data_spec] %s: %s", folder, exc)


def _pend(folder: Path) -> None:
    try:
        doc = _read(folder)
        _PENDING[qualified(kind_of(folder), namespace_of(folder, doc))] = folder
    except (DeclareError, ValueError) as exc:  # ValueError: a namespace or kind the grammar refuses
        _ERRORS[folder] = str(exc)


def load_root(root: Path) -> dict[Path, str]:
    """Register every data spec under ``root`` -- nested at any depth, in dependency order.

    Returns ``{folder: error}``; ``""`` means it registered (or is a documentation node).
    """
    with _lock:
        folders = data_spec_folders(root)
        for folder in folders:
            _pend(folder)
        for folder in folders:
            tag = next((t for t, f in _PENDING.items() if f == folder), None)
            if tag is not None:
                _build_pending(tag)
        return {folder: _ERRORS.get(folder, "") for folder in folders}


def register_folder(folder: Path) -> str:
    """Register one data spec folder (indexing calls this); its error, or ``""``.

    Its siblings in the same tree are pended first, so a definition indexed before the kinds it
    names still resolves them.
    """
    folder = Path(folder)
    with _lock:
        top = folder
        for parent in folder.parents:
            if parent.name == ASSETS_DIR:
                top = parent.parent
        for other in data_spec_folders(top):
            if other != folder and other not in _OWNER.values():
                _pend(other)
        _pend(folder)
        tag = next((t for t, f in _PENDING.items() if f == folder), None)
        if tag is not None:
            _build_pending(tag)
        return _ERRORS.get(folder, "")


def ensure_shipped() -> None:
    """Register every data spec this build ships -- once per process (the kind loader's bare miss)."""
    global _shipped_loaded
    with _lock:
        if _shipped_loaded:
            return
        _shipped_loaded = True
        from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

        load_root(flowpad_assistant_project_root())


def error_for(folder: Path) -> str:
    return _ERRORS.get(Path(folder), "")


__all__ = [
    "DeclareError",
    "data_spec_folders",
    "ensure_shipped",
    "error_for",
    "kind_of",
    "load_root",
    "register_folder",
]
