"""Loading data driver assets — a folder becomes a registered ``DataDriver``.

A data source is self-contained in its asset folder (``agentic-assets/data_driver/<name>/``): the
manifest ``data_driver.json``, the ``source.py`` holding exactly one ``flow_sdk.sources.Source``
subclass, and any helper modules beside it (``from .transport import …``). Shipped and authored
sources are the same kind of thing and load the same way.

**Import.** The folder is imported as a package named for its content, ``flowpad_source_<name>_<sha8>``:
two folders with one name never share a module, and a changed ``source.py`` is a new package rather
than a stale one. Loaded once per content hash and cached in ``sys.modules``, so a test that patches a
module attribute patches what the class reads.

**Discovery.** The shipped folders are scanned from the wheel on the registry's first lookup — no
database, deterministic, warm before the first poll. An authored folder registers on a name-scoped
miss (``DataDriver.get``), read off its ``DataDriver`` row; never from the indexer's
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
from contextlib import contextmanager
from pathlib import Path
from types import ModuleType
from typing import Iterator, TYPE_CHECKING, Optional

from flow_sdk.assets.placement import AGENTIC_ASSETS_DIR
from flow_sdk.assets.project_manifest import namespace_for
from flow_sdk.schema.data_spec._namespace import loading as loading_ns
from flow_sdk.schema.data_spec.data_driver_spec import SOURCE_FILE, DataDriverSpec
from flow_sdk.sources.base import Source

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.data_driver import DataDriver
    from flow_sdk.utils.kind_registry import KindRegistry

logger = logging.getLogger(__name__)

SHIPPED_ROOT = Path(__file__).resolve().parents[1] / "system_projects" / "flowpad_assistant" / "agentic-assets" / "data_driver"
MANIFEST_FILE = "data_driver.json"

#: ``{name: why it did not load}`` — read by ``DataDriver.load_error``.
_LOAD_ERRORS: dict[str, str] = {}


class DriverLoadError(Exception):
    """A data source folder that cannot become a source type. The message is shown to its author."""


def read_manifest(folder: Path) -> DataDriverSpec:
    try:
        raw = json.loads((folder / MANIFEST_FILE).read_text(encoding="utf-8"))
    except (OSError, ValueError) as exc:
        raise DriverLoadError(f"{folder}: {MANIFEST_FILE} is unreadable: {exc}") from exc
    try:
        return DataDriverSpec.model_validate(raw)
    except ValueError as exc:
        raise DriverLoadError(f"{folder}: {MANIFEST_FILE} is invalid: {exc}") from exc


def content_hash(folder: Path) -> str:
    """The folder's code, hashed: every top-level module, by name and bytes."""
    digest = hashlib.sha256()
    for path in sorted(folder.glob("*.py")):
        digest.update(path.name.encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def load_module(folder: Path, module: str = "source", *, digest: str = "") -> ModuleType:
    """``<folder>/<module>.py``, imported inside the folder's own package (``digest``: the folder's
    ``content_hash`` when the caller already has it)."""
    folder = folder.resolve()
    package = f"flowpad_source_{re.sub(r'[^0-9A-Za-z_]', '_', folder.name)}_{(digest or content_hash(folder))[:8]}"
    if package not in sys.modules:
        spec = importlib.machinery.ModuleSpec(package, None, is_package=True)
        spec.submodule_search_locations = [str(folder)]
        sys.modules[package] = importlib.util.module_from_spec(spec)
    try:
        return importlib.import_module(f"{package}.{module}")
    except DriverLoadError:
        raise
    except Exception as exc:  # noqa: BLE001 — an author's import error is a load error, not a crash
        raise DriverLoadError(f"{folder / (module + '.py')} failed to import: {type(exc).__name__}: {exc}") from exc


def driver_class(module: ModuleType) -> type[Source]:
    """The one concrete ``Source`` subclass ``module`` defines."""
    defined = [
        obj for obj in vars(module).values()
        if inspect.isclass(obj) and issubclass(obj, Source) and obj.__module__ == module.__name__ and not inspect.isabstract(obj)
    ]
    if len(defined) != 1:
        names = ", ".join(sorted(c.__name__ for c in defined)) or "none"
        raise DriverLoadError(f"{module.__file__} must define exactly one Source subclass (found: {names})")
    return defined[0]


@contextmanager
def _importing(folder: Path, manifest: DataDriverSpec, *, shipped: bool) -> "Iterator[None]":
    """Declare whose ontology this driver's kinds belong to, for the import that mints them.

    Resolving, refusing and declaring are ONE step on purpose. They must always
    happen together and they must happen BEFORE the import, because importing
    ``source.py`` is what mints the kinds — a driver that has not named its
    ontology has to be refused while its classes are still undefined. Split
    apart, the next reader copies the declaration and forgets the gate, and
    forgetting the gate is silent: an externally authored ``whatsapp`` would
    register ``ingest.message.whatsapp``, the same string the shipped one
    declares, and one of them loses with nothing said anywhere.
    """
    # What we ship is ours. Otherwise the driver's own declaration, else its
    # project's — a project names its namespace once and its assets inherit it.
    ns = "" if shipped else (manifest.ns or namespace_for(folder))
    if not shipped and not ns:
        raise DriverLoadError(
            f"{folder} declares no `ns`: an externally authored data driver must name the "
            "ontology namespace its kinds belong to, or they land in ours"
        )
    with loading_ns(ns):
        yield


def load_driver(folder: Path) -> "DataDriver":
    """A data source folder as a source type, or ``DriverLoadError`` naming what is wrong."""

    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    manifest = read_manifest(folder)
    if not (folder / SOURCE_FILE).is_file():
        raise DriverLoadError(f"{folder} has no {SOURCE_FILE} — a data source carries its own Source class")
    shipped = folder.resolve().is_relative_to(SHIPPED_ROOT)
    digest = content_hash(folder)
    with _importing(folder, manifest, shipped=shipped):
        cls = driver_class(load_module(folder, digest=digest))
    if cls.provider != manifest.name:
        raise DriverLoadError(f"{cls.__name__}.provider is {cls.provider!r} but the manifest names {manifest.name!r}")
    check_config(cls, manifest)
    return DataDriver.for_class(cls, manifest, folder=folder, content_hash=digest, shipped=shipped)


def check_config(cls: type[Source], manifest: DataDriverSpec) -> None:
    """A driver's ``Config`` and its manifest's form catalog name the same fields, and none is a secret.

    A catalog field with no ``Config`` field is a form input the source never reads; a ``Config`` field
    with no catalog entry is one the form can never set (``derived`` fields excepted — the application
    fills those). A secret belongs to ``auth``: a config lands in ``data_source.json``.
    """
    config = cls.Config
    if config is None:
        return
    declared = set(config.model_fields) - set(config.derived)
    catalog = set(manifest.config or {})
    if declared != catalog:
        missing, extra = sorted(declared - catalog), sorted(catalog - declared)
        raise DriverLoadError(
            f"{manifest.name}: the config catalog and {config.__name__} disagree"
            + (f" — no form hints for {missing}" if missing else "")
            + (f" — hints for fields {config.__name__} does not have: {extra}" if extra else "")
        )
    auth = manifest.auth
    secret_keys = set(auth.env) | set(auth.secrets) | set(auth.vars) if auth is not None else set()
    secrets = sorted(set(config.secret_fields()) | (set(config.model_fields) & secret_keys))
    if secrets:
        raise DriverLoadError(f"{manifest.name}: {config.__name__} declares secrets {secrets} — a secret is a credential in auth, never config")


def asset_module(name: str, module: str = "source") -> ModuleType:
    """A shipped source's module — what its own tests, and nothing else, import."""
    return load_module(SHIPPED_ROOT / name, module)


def load_driver_value_kinds() -> None:
    """Load the shipped source folders, which registers the payload kinds their classes
    define. The registry builds once; every later call is a flag check.

    ``ensure()`` rather than ``kinds()``: this runs on every bare-kind miss, and
    ``kinds()`` sorted the whole table to produce a list nobody reads.
    """
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    DRIVERS.ensure()


def _register_folders(registry: "KindRegistry[DataDriver]", root: Path, label: str) -> None:
    """Every driver folder under ``root``, into ``registry``.

    One definition of "import every driver folder here", because there are two roots
    — what we ship, and a project's own — and only the root differs. A name already
    registered (a test's double, a driver an earlier pass loaded) is left alone, and a
    folder that fails is logged and recorded, never raised: one broken source must not
    take the registry down with it.
    """
    if not root.is_dir():
        return
    for folder in sorted(p for p in root.iterdir() if (p / MANIFEST_FILE).is_file()):
        name = folder.name
        if registry.get_or_none(name) is not None:
            continue
        try:
            # ``load_driver`` re-derives the namespace from the folder's own manifest,
            # so an authored driver's kinds land under the owner the ASSET declares.
            registry.register(load_driver(folder))
            _LOAD_ERRORS.pop(name, None)
        except DriverLoadError as exc:
            _LOAD_ERRORS[name] = str(exc)
            logger.error("[sources] %s data source %s did not load: %s", label, name, exc)


def load_namespace_value_kinds(ns: str) -> None:
    """Import the data drivers of the project that OWNS ``ns``, registering their kinds.

    Synchronous by contract — it is called from ``SchemaRegistry.kind_type`` while a row
    is being validated, so it may not await and may not touch the database. The project
    is looked up in the namespace map, which the indexing paths keep filled.

    An unknown namespace loads NOTHING. There is deliberately no search of other
    projects for a matching kind: finding it under the wrong owner is exactly the
    collision the namespace exists to prevent (see ``_importing``).
    """
    from flow_sdk.fs_store.operations import namespace_roots  # noqa: PLC0415 — cycle
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    root = namespace_roots.claim_unloaded(ns)
    if root is not None:
        _register_folders(DRIVERS, root / AGENTIC_ASSETS_DIR / "data_driver", "authored")


def register_shipped(registry: "KindRegistry[DataDriver]") -> None:
    """Every folder this build ships, into ``registry``."""
    _register_folders(registry, SHIPPED_ROOT, "shipped")


async def resolve(name: str) -> "Optional[DataDriver]":
    """``DataDriver.get``: registered, or an authored folder loaded now from its indexed row. An
    authored folder whose code changed since it loaded is loaded again."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    known = DRIVERS.get_or_none(name or "")
    if known is not None and (known.folder is None or known.shipped):
        return known
    folder = await _authored_folder(name)
    if folder is None:
        return known
    if known is not None and known.folder == folder and known.content_hash == content_hash(folder):
        return known
    try:
        loaded = load_driver(folder)
    except DriverLoadError as exc:
        _LOAD_ERRORS[name] = str(exc)
        logger.warning("[sources] %s did not load: %s", name, exc)
        return known
    _LOAD_ERRORS.pop(name, None)
    return DRIVERS.register(loaded)


async def _authored_folder(name: str) -> Optional[Path]:
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    try:
        spec = await DataDriver.get_one({"name": name})
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
    "DriverLoadError",
    "asset_module",
    "content_hash",
    "load_error_for",
    "load_module",
    "load_driver",
    "read_manifest",
    "register_shipped",
    "resolve",
    "driver_class",
]
