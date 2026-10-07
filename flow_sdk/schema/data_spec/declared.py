"""Schemas DEFINED BY A FOLDER: build ``data_schema/<full.kind>/data_schema.json`` into a ``DataSpec``
class registered under its kind.

The ontology's other path mints a schema by importing code (``driver_registry``: a data driver's
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
nobody defines -- each becomes the folder's error, which indexing writes onto the row.

**An unchanged folder is read and built once** -- a cost saving: indexing reaches one definition
several ways (each data schema folder, the miss loader).

Namespace: ``project_manifest.asset_namespace``, the rule data drivers use -- ours if shipped, else
the document's ``ns``, else its project's; an external that names none is refused.
"""

from __future__ import annotations

import logging
import re
import threading
from pathlib import Path
from typing import Any, ClassVar, Optional, get_args

from pydantic import Field, ValidationError, create_model

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.schema.data_spec._namespace import loading, qualified
from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaDocSpec
from flow_sdk.schema.data_spec.dataset_spec import DatasetSpec, ExampleSpec
from flow_sdk.schema.data_spec.spec import ENUM_PREFIX, OPTIONAL_MARK, DataSpec, _compile, _field_def, _normalize_form
from flow_sdk.schema.types import EntityType

logger = logging.getLogger(__name__)

MAIN = DataSchemaDocSpec.main_file
FAMILY = EntityType.DATA_SCHEMA.value

_lock = threading.RLock()


class DeclareError(ValueError):
    """Why a data schema folder did not register."""


class _Read:
    """One definition as read: its text (the cache key), the document, its tag and namespace."""

    __slots__ = ("source", "doc", "tag", "ns")

    def __init__(self, source: str, doc: DataSchemaDocSpec, tag: str, ns: str) -> None:
        self.source, self.doc, self.tag, self.ns = source, doc, tag, ns


#: folder -> what it was last read as.
_READ: dict[Path, _Read] = {}
#: tag -> folder, pending a build.
_PENDING: dict[str, Path] = {}
#: tag -> the folder that defines it (a second folder for the same tag is an error).
_OWNER: dict[str, Path] = {}
#: folder -> (the text it was built from, the class built -- None for a documentation node).
_BUILT: dict[Path, tuple[str, Optional[type]]] = {}
#: folder -> why it did not register ("" when it did).
_ERRORS: dict[Path, str] = {}
_BUILDING: set[str] = set()
_shipped_loaded = False


# ── finding and reading folders ──────────────────────────────────────────────


def data_schema_folders(root: Path) -> list[Path]:
    """Every data schema folder under ``root``'s ``agentic-assets/``, at any depth of nesting.

    Walks only ``agentic-assets`` trees -- an asset's own children live there -- so a project
    root costs a few directory listings, never a crawl of its sources.
    """
    out: list[Path] = []
    seen: set[Path] = set()

    def walk(container: Path) -> None:
        assets = container / AGENTIC_ASSETS_DIR
        if not assets.is_dir() or assets.resolve() in seen:  # a symlinked tree is walked once
            return
        seen.add(assets.resolve())
        for family in sorted(p for p in assets.iterdir() if p.is_dir()):
            for asset in sorted(p for p in family.iterdir() if p.is_dir()):
                if family.name == FAMILY and (asset / MAIN).is_file():
                    out.append(asset)
                walk(asset)

    walk(Path(root))
    return out


def _read(folder: Path) -> _Read:
    """The folder's definition -- parsed once per change of its text."""
    from flow_sdk.assets.project_manifest import asset_namespace  # noqa: PLC0415 — owns manifests
    from flow_sdk.assets.serialization import read_entity_json  # noqa: PLC0415
    from flow_sdk.config import is_running_install_path  # noqa: PLC0415
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    try:
        source = (folder / MAIN).read_text(encoding="utf-8")
    except OSError as exc:
        raise DeclareError(f"{MAIN} is unreadable: {exc}") from exc
    known = _READ.get(folder)
    if known is not None and known.source == source:
        return known
    try:
        header, bodies = read_entity_json(SchemaRegistry.get(FAMILY), folder)
        doc = DataSchemaDocSpec.model_validate({**header, **bodies})
    except ValidationError as exc:
        raise DeclareError(f"{MAIN} is not a data schema: {exc.errors()[0].get('msg', exc)}") from exc
    except ValueError as exc:  # unreadable JSON, a document of another type
        raise DeclareError(f"{MAIN}: {exc}") from exc
    shipped = is_running_install_path(folder)
    ns = asset_namespace(folder, doc.ns, shipped=shipped)
    if not shipped and not ns:
        raise DeclareError(
            "declares no `ns`: an externally authored data schema must name the ontology namespace "
            "its kind belongs to, or it lands in ours"
        )
    try:
        tag = qualified(Path(folder).name, ns)  # the folder name IS the kind
    except ValueError as exc:
        raise DeclareError(str(exc)) from exc
    read = _READ[folder] = _Read(source, doc, tag, ns)
    return read


def subkind_of(folder: Path) -> Optional[str]:
    """What the folder's definition resolves to (``record`` / ``dataset``), once it has been read."""
    read = _READ.get(Path(folder))
    return read.doc.resolved_subkind if read is not None else None


# ── building ─────────────────────────────────────────────────────────────────


def _bare(form: str) -> str:
    return form[len(OPTIONAL_MARK) :] if form.startswith(OPTIONAL_MARK) else form


def _refs(form: Any) -> list[str]:
    """The kind names a form refers to (``?`` stripped; enums and primitives are not kinds)."""
    from flow_sdk.schema.data_spec._kinds import PRIMITIVES  # noqa: PLC0415

    if isinstance(form, str):
        name = _bare(form)
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
        q = qualified(_bare(form), ns)
        if q in _PENDING or q in _OWNER:
            return (OPTIONAL_MARK if form.startswith(OPTIONAL_MARK) else "") + q
        return form
    if isinstance(form, list):
        return [_qualify(item, ns) for item in form]
    if isinstance(form, dict):
        return {k: _qualify(v, ns) for k, v in form.items()}
    return form


def _contains_any(annotation: Any) -> bool:
    return annotation is Any or any(_contains_any(arg) for arg in get_args(annotation))


def _build(folder: Path) -> Optional[type]:
    """Compile and register ONE folder; dependencies first. Raises ``DeclareError``."""
    read = _read(folder)
    built = _BUILT.get(folder)
    if built is not None and built[0] == read.source:
        return built[1]
    doc, tag = read.doc, read.tag
    if doc.resolved_subkind is None:
        _BUILT[folder] = (read.source, None)
        return None  # a documentation node: it names no shape, so it registers nothing
    owner = _OWNER.get(tag)
    if owner is not None and owner.resolve() != folder.resolve():
        raise DeclareError(f"kind {tag!r} is already defined by {owner}")

    record = doc.resolved_subkind == "record"
    raw = {name: f.shape for name, f in (doc.fields or {}).items()} if record else dict(doc.examples or {})
    forms = {name: _qualify(_normalize_form(form), read.ns) for name, form in raw.items()}

    # Build what this one names before compiling it, so no reference resolves to Any.
    for ref in {r for form in forms.values() for r in _refs(form)}:
        if ref in _BUILDING:
            raise DeclareError(f"kind {tag!r} and {ref!r} refer to each other")
        if ref in _PENDING:
            _build_pending(ref)

    _BUILDING.add(tag)
    try:
        with loading(read.ns):
            if record:
                defs = {name: _field_def(form) for name, form in forms.items()}
                types = {name: annotation for name, (annotation, _) in defs.items()}
            else:
                types = {slot: _compile(form) for slot, form in forms.items()}
            unknown = [name for name, annotation in types.items() if _contains_any(annotation)]
            if unknown:
                raise DeclareError(f"{unknown[0]!r} names a kind nobody defines: {forms[unknown[0]]!r}")
            if record:
                base: Any = DataSpec
                members = {
                    name: (annotation, Field(default, description=(doc.fields or {})[name].description or None))
                    for name, (annotation, default) in defs.items()
                }
            else:
                row = ExampleSpec[types["input"], types.get("output", DataSpec), types.get("context", DataSpec)]  # type: ignore[misc]
                base, members = DatasetSpec[row], {}  # type: ignore[valid-type]
            cls = create_model(  # type: ignore[call-overload]
                "Declared_" + re.sub(r"\W", "_", tag),
                __base__=base,
                __module__=__name__,
                __doc__=str(doc.description or "") or None,
                spec_kind=(ClassVar[str], Path(folder).name),
                # The forms the author WROTE (``enum:quick|agentic``, ``?string``) -- what a form
                # builder reads; ``to_authoring_form`` still renders the class as its tag.
                __authoring__=(ClassVar[Any], forms),
                **members,
            )
    except DeclareError:
        raise
    except (ValueError, TypeError) as exc:  # the registry refusing (a type name, a code-defined kind)
        raise DeclareError(str(exc)) from exc
    finally:
        _BUILDING.discard(tag)
    _OWNER[tag] = folder
    _BUILT[folder] = (read.source, cls)
    return cls


def _build_pending(tag: str) -> None:
    folder = _PENDING.pop(tag)
    try:
        _build(folder)
        _ERRORS[folder] = ""
    except DeclareError as exc:
        _ERRORS[folder] = str(exc)
        logger.warning("[data_schema] %s: %s", folder, exc)


def _pend(folder: Path) -> Optional[str]:
    """Record a folder as pending; its tag, or None when it cannot be read (its error recorded)."""
    try:
        tag = _read(folder).tag
    except DeclareError as exc:
        _ERRORS[folder] = str(exc)
        return None
    _PENDING[tag] = folder
    return tag


def _settle(folder: Path, tag: Optional[str]) -> None:
    if tag is not None and _PENDING.get(tag) == folder:
        _build_pending(tag)


def load_root(root: Path) -> dict[Path, str]:
    """Register every data schema under ``root`` -- nested at any depth, in dependency order.

    Returns ``{folder: error}``; ``""`` means it registered (or is a documentation node).
    """
    with _lock:
        tags = {folder: _pend(folder) for folder in data_schema_folders(root)}
        for folder, tag in tags.items():
            _settle(folder, tag)
        return {folder: _ERRORS.get(folder, "") for folder in tags}


def register_folder(folder: Path) -> str:
    """Register one data schema folder (indexing calls this); its error, or ``""``.

    The definitions of its tree not read yet are pended first, so a definition indexed before
    the kinds it names still resolves them.
    """
    folder = Path(folder)
    with _lock:
        top = folder
        for parent in folder.parents:
            if parent.name == AGENTIC_ASSETS_DIR:
                top = parent.parent
        for other in data_schema_folders(top):
            if other != folder and other not in _READ:
                _pend(other)
        _settle(folder, _pend(folder))
        return _ERRORS.get(folder, "")


def ensure_shipped() -> None:
    """Register every data schema this build ships -- once per process (the kind loader's bare miss)."""
    global _shipped_loaded
    with _lock:
        if _shipped_loaded:
            return
        _shipped_loaded = True
        from flow_sdk.config import flowpad_assistant_project_root  # noqa: PLC0415

        load_root(flowpad_assistant_project_root())


__all__ = ["DeclareError", "data_schema_folders", "ensure_shipped", "load_root", "register_folder", "subkind_of"]
