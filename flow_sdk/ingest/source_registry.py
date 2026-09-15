"""Loading data source assets — a folder becomes a registered ``SourceType``.

A data source is self-contained in its asset folder (``agentic-assets/data_source/<name>/``): the
manifest ``data_source.json``, the ``source.py`` holding exactly one ``flow_sdk.sources.Source``
subclass, and any helper modules beside it (``from .transport import …``). Shipped and authored
sources are the same kind of thing and load the same way.

**Import.** The folder is imported as a package named for its content, ``flowpad_source_<name>_<sha8>``:
two folders with one name never share a module, and a changed ``source.py`` is a new package rather
than a stale one. Loaded once per content hash and cached in ``sys.modules``, so a test that patches a
module attribute patches what the class reads.

**Discovery.** The shipped folders are scanned from the wheel on the registry's first lookup — no
database, deterministic, warm before the first poll. An authored folder registers on a name-scoped
miss (``resolve_source_type``), read off its ``DataSourceSpec`` row; never from the indexer's
per-record sync, which imports under the import lock.

**Collisions.** A shipped name wins; an authored folder claiming it records a load error instead.
"""
from __future__ import annotations

import hashlib
import importlib
import importlib.machinery
import importlib.util
import inspect
import json
import logging
import re
import sys
from pathlib import Path
from types import ModuleType
from typing import TYPE_CHECKING, Optional

from flow_sdk.schema.data_spec.data_source_manifest_spec import ManifestSpec
from flow_sdk.sources.base import Source

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.ingest.sources import SourceType
    from flow_sdk.utils.kind_registry import KindRegistry

logger = logging.getLogger(__name__)

SHIPPED_ROOT = Path(__file__).resolve().parents[1] / "system_projects" / "flowpad_assistant" / "agentic-assets" / "data_source"
MANIFEST_FILE = "data_source.json"
SOURCE_FILE = "source.py"

#: ``{name: why it did not load}`` — read by ``DataSourceSpec.load_error``.
_LOAD_ERRORS: dict[str, str] = {}


class SourceLoadError(Exception):
    """A data source folder that cannot become a source type. The message is shown to its author."""


def read_manifest(folder: Path) -> ManifestSpec:
    try:
        raw = json.loads((folder / MANIFEST_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise SourceLoadError(f"{folder}: {MANIFEST_FILE} is unreadable: {exc}") from exc
    try:
        return ManifestSpec.model_validate(raw)
    except ValueError as exc:
        raise SourceLoadError(f"{folder}: {MANIFEST_FILE} is invalid: {exc}") from exc


def content_hash(folder: Path) -> str:
    """The folder's code, hashed: every top-level module, by name and bytes."""
    digest = hashlib.sha256()
    for path in sorted(folder.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def load_module(folder: Path, module: str = "source") -> ModuleType:
    """``<folder>/<module>.py``, imported inside the folder's own package."""
    folder = folder.resolve()
    package = f"flowpad_source_{re.sub(r'[^0-9A-Za-z_]', '_', folder.name)}_{content_hash(folder)[:8]}"
    if package not in sys.modules:
        spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
        spec.submodule_search_locations = [str(folder)]
        sys.modules[package] = importlib.util.module_from_spec(spec)
    try:
        return importlib.import_module(f"{package}.{module}")
    except SourceLoadError:
        raise
    except Exception as exc:  # noqa: BLE001 — an author's import error is a load error, not a crash
        raise SourceLoadError(f"{folder / (module + '.py')} failed to import: {type(exc).__name__}: {exc}") from exc


def source_class(module: ModuleType) -> type[Source]:
    """The one concrete ``Source`` subclass ``module`` defines."""
    defined = [
        obj for obj in vars(module).values()
        if inspect.isclass(obj) and issubclass(obj, Source) and obj.__module__ == module.__name__ and not inspect.isabstract(obj)
    ]
    if len(defined) != 1:
        names = ", ".join(sorted(c.__name__ for c in defined)) or "none"
        raise SourceLoadError(f"{module.__file__} must define exactly one Source subclass (found: {names})")
    return defined[0]


def load_source(folder: Path) -> "SourceType":
    """A data source folder as a source type, or ``SourceLoadError`` naming what is wrong."""

    manifest = read_manifest(folder)
    if not (folder / SOURCE_FILE).is_file():
        raise SourceLoadError(f"{folder} has no {SOURCE_FILE} — a data source carries its own Source class")
    cls = source_class(load_module(folder))
    return _typed(cls, manifest, folder)


def _typed(cls: type[Source], manifest: ManifestSpec, folder: Path) -> "SourceType":
    from flow_sdk.ingest.sources import SourceType  # noqa: PLC0415

    if cls.provider != manifest.name:
        raise SourceLoadError(f"{cls.__name__}.provider is {cls.provider!r} but the manifest names {manifest.name!r}")
    return SourceType(cls, manifest, folder=folder)


def asset_module(name: str, module: str = "source") -> ModuleType:
    """A shipped source's module — what its own tests, and nothing else, import."""
    return load_module(SHIPPED_ROOT / name, module)


def register_shipped(registry: "KindRegistry[SourceType]") -> None:
    """Every shipped folder, into ``registry``; a name already registered (a test's) is left alone.
    A folder that fails is logged and recorded, never raised: one broken source must not take the
    registry down with it."""
    for folder in sorted(p for p in SHIPPED_ROOT.iterdir() if (p / MANIFEST_FILE).is_file()):
        name = folder.name
        if registry.get_or_none(name) is not None:
            continue
        try:
            registry.register(load_source(folder))
            _LOAD_ERRORS.pop(name, None)
        except SourceLoadError as exc:
            _LOAD_ERRORS[name] = str(exc)
            logger.error("[sources] shipped data source %s did not load: %s", name, exc)


async def resolve_source_type(name: str) -> "Optional[SourceType]":
    """The source type for ``name``: registered, or an authored folder loaded now from its spec row.
    An authored folder whose code changed since it loaded is loaded again."""
    from flow_sdk.ingest.sources import SOURCES, source_type  # noqa: PLC0415

    known = source_type(name)
    if known is not None and (known.folder is None or known.folder.resolve().is_relative_to(SHIPPED_ROOT)):
        return known
    folder = await _authored_folder(name)
    if folder is None:
        return known
    if known is not None and known.folder == folder and known.content_hash == content_hash(folder):
        return known
    try:
        loaded = load_source(folder)
    except SourceLoadError as exc:
        _LOAD_ERRORS[name] = str(exc)
        logger.warning("[sources] %s did not load: %s", name, exc)
        return known
    _LOAD_ERRORS.pop(name, None)
    return SOURCES.register(loaded)


async def _authored_folder(name: str) -> Optional[Path]:
    from flow_sdk.builtin.data_source_spec import DataSourceSpec  # noqa: PLC0415

    try:
        spec = await DataSourceSpec.get_one({"name": name})
    except Exception:  # noqa: BLE001 — no spec row is "no authored source"
        return None
    ref = str(getattr(spec, "asset_ref", "") or "") if spec is not None else ""
    if not ref:
        return None
    path = Path(ref)
    folder = (path.parent if path.name == MANIFEST_FILE else path).resolve()
    if folder.is_relative_to(SHIPPED_ROOT):
        return None
    return folder if (folder / MANIFEST_FILE).is_file() else None


def load_error_for(name: str) -> str:
    return _LOAD_ERRORS.get(name, "")


__all__ = [
    "MANIFEST_FILE",
    "SHIPPED_ROOT",
    "SOURCE_FILE",
    "SourceLoadError",
    "asset_module",
    "content_hash",
    "load_error_for",
    "load_module",
    "load_source",
    "read_manifest",
    "register_shipped",
    "resolve_source_type",
    "source_class",
]
