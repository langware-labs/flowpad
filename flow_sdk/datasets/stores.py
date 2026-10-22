"""Where a dataset's rows live: dataset → data source → data store.

``dataset.json`` names at most one DATA SOURCE (``"data_source": "gtm-drive"``) and, optionally, the rows'
folder inside it (``"path"``, the dataset's folder name by default). The source is the project's
``agentic-assets/data_source/<name>/data_source.json``; its driver's family decides how the rows are kept:

* an OBJECT store (``flow_storage``, S3, GCS, Drive -- a ``RowFiles`` source) holds whole rows as files,
  ``rows/<key>/row.json`` and the slot files beside it. A driver whose store is a folder on this machine
  (``rows_folder``: a mounted drive) is read and written there in place.
* a SYSTEM OF RECORD (a record driver: a CRM) holds the fields the row kind says are its own
  (``"truth"`` in the data model). Every row is kept whole in the project's data store; a pull mirrors the
  system's fields into it and a change to one goes to the system first (``datasets.projection``).

No ``data_source``: the rows are in the PROJECT'S DATA STORE -- the data source ``flow.json`` names as
``"data_store"``, else this instance's store, ``<instance>/data_stores/<project ns>/<dataset folder>/`` (a
folder on this machine, named by what the project's git holds, so a fresh clone or a moved project finds
its rows again). Never inside the project, never in git. A dataset folder outside any project (a standalone
dataset, itself data) is its own store: its ``rows/`` beside its ``dataset.json``; so is a log in Flowpad's
temp folder (``core/log_dataset``), which the OS clears.

A data source that is not set up on this machine holds nothing: its datasets refuse to read or write
(``NotSetUp``) until its setup is done. Rows are never kept anywhere else meanwhile.

Rows are always READ and WRITTEN through a local folder: the store's own for a folder, else a disposable
WORKING COPY under this instance (``<instance>/cache/rows/<dataset id>/``) that ``pull`` brings up to date and
``push`` sends back -- ``row.json`` is a row's commit point, sent last and conditioned on the version last
seen (``Conflict`` when someone else wrote it since).
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import hashlib
import logging
import os
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

logger = logging.getLogger(__name__)

FOLDER, FILES, RECORDS = "folder", "files", "records"
#: The working copy's own record of what it last saw in the store: ``{path: {"v": version, "h": hash}}``.
STATE_FILE = ".store.json"
#: How many files a pull reads at once.
PULL_CONCURRENCY = 8
#: Who writes a system of record's fields: the system itself (a pull, a write-through's answer).
SYSTEM = "soc"


class NotSetUp(LookupError):
    """The dataset's data source cannot hold its rows on this machine now (it owes setup, is off, or is
    not here): nothing is read or written until it can."""


@dataclass(frozen=True)
class Store:
    kind: str
    driver: str = ""
    config: dict = field(default_factory=dict)
    #: The data source the store is ("" for this instance's store), and the rows' folder inside it.
    source: str = ""
    path: str = ""
    #: FOLDER: the folder whose ``rows/`` holds the rows.
    folder: str = ""
    read_only: bool = False
    #: RECORDS: the store that keeps the rows whole (the project's data store).
    holder: Optional["Store"] = None

    @property
    def files(self) -> "Store":
        """The store that holds the row FILES: this one, or a system of record's holder."""
        return self.holder if self.kind == RECORDS and self.holder is not None else self

    @property
    def remote(self) -> bool:
        return self.files.kind == FILES

    @property
    def key(self) -> str:
        """What the store is, for a working copy's record of what it last saw."""
        files = self.files
        return f"{files.driver}:{files.source}:{files.path}:{sorted(files.config.items())}"

    def label(self) -> str:
        """How the store reads to a person (and in a log)."""
        if not self.source:
            return "project data store"
        return f"{self.source} · {self.path}" if self.path and self.kind != RECORDS else self.source


# ── the project's data source documents ─────────────────────────────────────────────────────────

def _project_of_folder(folder: Path | str) -> Optional[Path]:
    """The project a dataset folder sits in (the folder above its ``agentic-assets``), or None."""
    return next((parent.parent for parent in Path(folder).parents if parent.name == "agentic-assets"), None)


@functools.lru_cache(maxsize=256)
def _source_spec(manifest: str, mtime_ns: int) -> tuple[str, dict, bool]:
    """``(driver, config, read_only)`` of one ``data_source.json`` -- cached per file version."""
    from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    whole = load_json_dict(Path(manifest))
    spec = DataSourceSpec.model_validate(whole["metadata"] if isinstance(whole.get("metadata"), dict) else whole)
    return spec.provider, dict(spec.config), bool(spec.read_only)


def source_document(folder: Path | str, name: str) -> dict:
    """``data_source.json`` of the source ``name`` in the project of the dataset in ``folder``, as
    ``{"provider", "config", "read_only"}``; ``ValueError`` naming what is missing."""
    root = _project_of_folder(folder)
    manifest = root / "agentic-assets" / "data_source" / name / "data_source.json" if root else None
    if manifest is None or not manifest.is_file():
        raise ValueError(f"data_source: the project has no data source {name!r} (agentic-assets/data_source/{name}/)")
    provider, config, read_only = _source_spec(str(manifest), manifest.stat().st_mtime_ns)
    if not provider:
        raise ValueError(f"data_source: {name!r} names no driver")
    return {"provider": provider, "config": dict(config), "read_only": read_only}


def project_data_store(folder: Path | str) -> str:
    """The data source the project of the dataset in ``folder`` keeps its rows in (``flow.json``
    ``"data_store"``), or ``""`` for this instance's store."""
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    root = _project_of_folder(folder)
    named = load_json_dict(root / "flow.json").get("data_store") if root is not None else None
    return str(named or "")


def _driver_class(provider: str, folder: Path | str = "") -> Any:
    """The driver class ``provider`` names: registered (shipped, or loaded before), else the project's own
    ``agentic-assets/data_driver/<provider>/`` loaded now -- a dataset is read in processes (the indexer, a
    script) that have not loaded the project's drivers yet."""
    from flow_sdk.ingest.driver_runtime import DRIVERS  # noqa: PLC0415

    driver = DRIVERS.get_or_none(provider)
    root = _project_of_folder(folder) if folder else None
    authored = root / "agentic-assets" / "data_driver" / provider if root is not None else None
    if driver is None and authored is not None and (authored / "data_driver.json").is_file():
        from flow_sdk.ingest.driver_registry import DriverLoadError, load_driver  # noqa: PLC0415

        try:
            driver = DRIVERS.register(load_driver(authored))
        except DriverLoadError as exc:
            raise ValueError(f"data_source: the {provider} driver did not load: {exc}") from exc
    if driver is None:
        raise ValueError(f"data_source: no {provider} driver on this machine")
    return driver.cls


def _is_system_of_record(cls: Any) -> bool:
    from flow_sdk.sources.base import Family  # noqa: PLC0415

    return getattr(cls, "family", None) == Family.RECORD


def instance_store(folder: Path | str) -> Path:
    """This instance's store for the dataset in ``folder``: ``<instance>/data_stores/<project ns>/<dataset
    folder>/`` -- the project's ``ns`` (``project_manifest.json``; its path's digest when it declares none). A
    dataset folder outside any project is its own store."""
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    base = get_instance_settings().instance_dir / "data_stores"
    root = _project_of_folder(folder)
    if root is None:   # a standalone dataset folder is its own store
        return Path(folder)
    from flow_sdk.core.log_dataset import temp_datasets  # noqa: PLC0415

    if Path(folder).resolve().parent == temp_datasets().resolve():   # a temp log keeps its rows in temp
        return Path(folder)
    manifest = root / "agentic-assets" / "project_manifest" / "project_manifest.json"
    ns = str(load_json_dict(manifest).get("ns") or "") or _digest(str(root.resolve()).encode())
    return base / ns / Path(folder).name


def _object_store(folder: Path | str, name: str, path: str) -> Store:
    found = source_document(folder, name)
    cls = _driver_class(found["provider"], folder)
    if _is_system_of_record(cls):
        raise ValueError(f"data_store: {name!r} is a system of record; a project's data store holds files")
    rows_folder = getattr(cls, "rows_folder", None)
    if rows_folder is not None:   # a store on this machine (a mounted drive): read and written in place
        return Store(FOLDER, driver=found["provider"], source=name, path=path,
                     folder=str(Path(rows_folder(found["config"], path))), read_only=found["read_only"])
    within = getattr(cls, "rows_within", None)
    if within is None:
        raise ValueError(f"data_source: the {found['provider']} driver cannot hold a dataset's rows")
    return Store(FILES, driver=found["provider"], config=within(dict(found["config"]), path), source=name, path=path,
                 read_only=found["read_only"])


def default_store(folder: Path | str) -> Store:
    """The project's data store for the dataset in ``folder``."""
    named = project_data_store(folder)
    if named:
        return _object_store(folder, named, Path(folder).name)
    return Store(FOLDER, folder=str(instance_store(folder)))


def resolve(folder: Path | str, source: Any, path: Any = None) -> Store:
    """Where the rows of the dataset in ``folder`` live: the one rule every reader and writer uses.
    ``ValueError`` naming what is wrong (a source the project does not declare, a driver not here)."""
    if not source:
        return default_store(folder)
    name = str(source)
    found = source_document(folder, name)
    if _is_system_of_record(_driver_class(found["provider"], folder)):
        return Store(RECORDS, driver=found["provider"], config=dict(found["config"]), source=name,
                     read_only=found["read_only"], holder=default_store(folder))
    return _object_store(folder, name, str(path or Path(folder).name).strip("/"))


# ── is the source set up here ────────────────────────────────────────────────────────────────────

#: What each named source answered in this process: ``{source name: why}``, ``""`` when it holds rows.
_checked: dict[str, str] = {}


async def source_refusal(name: str, project_id: str = "") -> str:
    """Why the data source ``name`` cannot hold rows on this machine now, or ``""``."""
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415
    from flow_sdk.builtin.data_source import DataSource, SourceStatus  # noqa: PLC0415
    from flow_sdk.ingest.health import SourceHealth  # noqa: PLC0415

    rows = await DataSource.get_all({"name": name}) or []
    if project_id and len(rows) > 1:
        rows = [row for row in rows if str(getattr(row, "project_id", "") or "") == project_id] or rows
    if not rows:
        return f"{name} is not set up on this machine"
    row = rows[0]
    if await DataDriver.find(row.provider or "") is None:
        return f"{name}: no {row.provider} driver on this machine"
    if owed := row.setup_owed():
        return f"{name} needs setup: {owed}"
    if row.status == SourceStatus.DISABLED.value:
        return f"{name} is turned off"
    if row.health == SourceHealth.CONFIG_ERROR.value:
        return f"{name}: {row.error_detail or 'configuration error'}"
    return ""


def _sources_of(dataset: Any) -> list[str]:
    """The data sources a dataset's rows need: its own and the project's data store."""
    names = [str(dataset.data_source)] if getattr(dataset, "data_source", None) else []
    if getattr(dataset, "asset_ref", "") and (store := project_data_store(dataset.asset_ref)) and store not in names:
        names.append(store)
    return names


async def readiness(dataset: Any, *, cached: bool = False) -> str:
    """Why the dataset's rows cannot be read or written now, or ``""``. ``cached``: an answer already
    given in this process stands (a source's verify refreshes it: ``refresh_hosted``)."""
    for name in _sources_of(dataset):
        if not cached or name not in _checked:
            try:
                _checked[name] = await source_refusal(name, await project_of(dataset))
            except Exception as exc:  # noqa: BLE001 -- an index that cannot answer: said, as a refusal
                _checked[name] = f"{name} could not be checked ({exc})"
        if _checked[name]:
            return _checked[name]
    return ""


async def require_ready(dataset: Any, *, cached: bool = True) -> None:
    if why := await readiness(dataset, cached=cached):
        raise NotSetUp(why)


async def refresh_hosted(source: Any, datasets: Optional[list] = None) -> None:
    """A source answered (its verify ran): every dataset it hosts takes the answer, and one whose working
    copy was never filled is pulled -- behind the check, never in it."""
    datasets = await source.datasets() if datasets is None else datasets
    try:
        _checked[str(source.name)] = await source_refusal(str(source.name), str(getattr(source, "project_id", "") or ""))
    except Exception as exc:  # noqa: BLE001
        _checked[str(source.name)] = f"{source.name} could not be checked ({exc})"
    if _checked[str(source.name)] or not datasets:
        return
    task = asyncio.create_task(_first_pulls([d for d in datasets if getattr(d, "asset_ref", "")]))
    _filling.add(task)
    task.add_done_callback(_filling.discard)


async def refresh_all_hosted() -> None:
    """Every source some dataset names answers once -- at startup. Reads the source rows only."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    in_source = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["data_source"]))
    names = sorted({str(d.data_source) for d in await Dataset.get_all(in_source) or [] if getattr(d, "data_source", None)})
    for name in names:
        for source in await DataSource.get_all({"name": name}) or []:
            try:
                await refresh_hosted(source)
            except Exception:  # noqa: BLE001 -- one source never holds up the rest
                logger.warning("data source %s: could not be checked for its datasets", name, exc_info=True)


#: The first-pull passes running now (held so a task is not collected mid-run).
_filling: set = set()


async def _first_pulls(datasets: list) -> None:
    for dataset in datasets:
        try:
            store = dataset._rows_store()
            if store.remote and not (rows_folder(dataset, store) / STATE_FILE).is_file():
                async with session(dataset, store, write=False):
                    pass
                await dataset.refresh_counts()
        except Exception:  # noqa: BLE001 -- the next session of that dataset pulls it anyway
            logger.warning("dataset %s: first pull failed", getattr(dataset, "name", ""), exc_info=True)


# ── the folder the row code reads and writes ─────────────────────────────────────────────────────

def rows_root(folder: Path | str, store: Store, dataset_id: str) -> Path:
    """The local folder whose ``rows/`` holds the dataset's rows: the store's own folder, or the working
    copy of a remote one."""
    files = store.files
    if files.kind == FOLDER:
        return Path(files.folder)
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "cache" / "rows" / (dataset_id or _digest(str(folder).encode()))


def rows_folder(dataset: Any, store: Store) -> Path:
    return rows_root(dataset.asset_ref, store, str(dataset.id or ""))


def rows_root_of(folder: Path | str, header: Optional[dict] = None, dataset_id: Optional[str] = None) -> Path:
    """``rows_root`` for a dataset read from disk alone: its ``data_source`` / ``path`` from ``header`` (the
    manifest's metadata) or ``dataset.json``, its id from the folder's identity."""
    folder = Path(folder)
    if header is None:
        from flow_sdk.schema.data_spec.layout import load_doc  # noqa: PLC0415

        header = load_doc(folder / "dataset.json")[0]
    if dataset_id is None:
        from flow_sdk.schema.data_spec.io.identity import FolderCapsule  # noqa: PLC0415

        dataset_id = FolderCapsule().read(folder) or ""
    return rows_root(folder, resolve(folder, header.get("data_source"), header.get("path")), dataset_id)


# ── opening a driver as a store ───────────────────────────────────────────────────────────────────

#: A test double's seam: ``(store) -> async context manager yielding the opened source``.
OPENER: Optional[Callable[[Store], Any]] = None


async def project_of(dataset: Any) -> str:
    """The id of the project a dataset belongs to: where its source's driver finds the credential its
    manifest names (a credential declared in that project, else the user's)."""
    if getattr(dataset, "project_id", None):
        return str(dataset.project_id)
    from flow_sdk.context import current_project  # noqa: PLC0415

    try:
        project = await current_project(cwd=str(dataset.asset_ref)) if getattr(dataset, "asset_ref", "") else None
    except Exception:  # noqa: BLE001 -- no index to ask (a bare script): the user's credentials alone
        project = None
    return str(project.id) if project is not None else ""


@contextlib.asynccontextmanager
async def opened(store: Store, project_id: str = "") -> AsyncIterator[Any]:
    """The store's driver, configured and opened, as its source (``RowFiles`` or a record source)."""
    if OPENER is not None:
        async with OPENER(store) as source:
            yield source
        return
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = await DataDriver.get(store.driver)
    source = driver.create_source(dict(store.config), name=f"rows in {store.label()}",
                                  **({"project_id": project_id} if project_id else {}))
    async with await source.open() as live:
        yield live.source


# ── the working copy ──────────────────────────────────────────────────────────────────────────────

def _digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()[:16]


def _local_files(root: Path) -> dict[str, Path]:
    """Every row file of the working copy, by its path relative to ``root`` (``rows/...``)."""
    out: dict[str, Path] = {}
    base = root / "rows"
    if not base.is_dir():
        return out
    for here, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if not d.startswith(".")]
        for name in files:
            if not name.startswith("."):
                path = Path(here) / name
                out[path.relative_to(root).as_posix()] = path
    return out


def _row_of(path: str) -> Optional[str]:
    """``acme`` for ``rows/acme/input/x.json``; None for anything outside a row folder."""
    parts = path.split("/")
    return parts[1] if len(parts) >= 3 and parts[0] == "rows" else None


def _seen(root: Path, store: Store) -> dict:
    """What the working copy last saw in ``store``: ``{path: {"v", "h"}}`` -- empty for a copy of another
    store (or none yet)."""
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    state = load_json_dict(root / STATE_FILE)
    files = state.get("files")
    return files if state.get("store") == store.key and isinstance(files, dict) else {}


def _save_state(root: Path, store: Store, files: dict) -> None:
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    root.mkdir(parents=True, exist_ok=True)
    write_json_atomic(root / STATE_FILE, {"store": store.key, "files": files})


async def pull_files(source: Any, root: Path, store: Store) -> list[str]:
    """Make the working copy ``root`` hold exactly what the store holds: a file changed there, or changed
    here without being pushed, is read again; one gone there goes here. A row there without ``row.json``
    is skipped. Returns the keys of the rows that moved."""
    seen = _seen(root, store)
    remote = await source.list_files()
    committed = {_row_of(p) for p in remote if p.endswith("/row.json") and p.count("/") == 2}
    remote = {p: v for p, v in remote.items() if _row_of(p) in committed}
    local = _local_files(root)
    files, moved, stale = {}, set(), []
    for path, version in remote.items():
        held = seen.get(path) or {}
        here = local.get(path)
        if here is not None and held.get("v") == version and _digest(here.read_bytes()) == held.get("h"):
            files[path] = held
        else:
            stale.append((path, version))
    gate = asyncio.Semaphore(PULL_CONCURRENCY)

    async def fetch(path: str, version: str) -> None:   # the files are independent: read side by side
        async with gate:
            data = await source.read_file(path)
        target = root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(data)
        files[path] = {"v": version, "h": _digest(data)}
        moved.add(_row_of(path))

    await asyncio.gather(*(fetch(path, version) for path, version in stale))
    for path, here in local.items():
        if path not in remote:
            here.unlink(missing_ok=True)
            moved.add(_row_of(path))
    _prune_empty(root / "rows")
    _save_state(root, store, files)
    return sorted(k for k in moved if k)


def _prune_empty(base: Path) -> None:
    if not base.is_dir():
        return
    for here, _dirs, _files in os.walk(base, topdown=False):
        path = Path(here)
        if path != base and not any(path.iterdir()):
            path.rmdir()


async def push_files(source: Any, root: Path, store: Store) -> list[str]:
    """Send what changed in the working copy since the last pull or push: per row, its slot files first
    and ``row.json`` LAST, conditioned on the version last seen; a row gone here goes there, ``row.json``
    last again. ``Conflict`` when another writer moved a row since. Returns the keys sent."""
    from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

    seen = _seen(root, store)
    local = {path: here.read_bytes() for path, here in _local_files(root).items()}
    changed: dict[str, dict[str, Optional[bytes]]] = {}
    for path, data in local.items():
        if (seen.get(path) or {}).get("h") != _digest(data):
            changed.setdefault(_row_of(path) or "", {})[path] = data
    for path in seen:
        if path not in local:
            changed.setdefault(_row_of(path) or "", {})[path] = None
    changed.pop("", None)
    if not changed:
        return []
    remote = await source.list_files()
    files = dict(seen)
    for key, paths in sorted(changed.items()):
        meta = f"rows/{key}/row.json"
        expected = (seen.get(meta) or {}).get("v", "")
        if remote.get(meta, "") != expected:
            raise Conflict(f"row {key!r} changed in {store.label()} since it was read")
        gone = meta not in local
        for path, data in sorted(paths.items()):
            if path == meta:
                continue
            if data is None:
                await source.delete_file(path)
                files.pop(path, None)
            else:
                files[path] = {"v": await source.write_file(path, data), "h": _digest(data)}
        if gone:
            for path in [p for p in remote if _row_of(p) == key and p != meta and p not in paths]:
                await source.delete_file(path)
                files.pop(path, None)
            if meta in remote:
                await source.delete_file(meta, expected=expected)
            files.pop(meta, None)
        else:
            data = local[meta]
            files[meta] = {"v": await source.write_file(meta, data, expected=expected), "h": _digest(data)}
    _save_state(root, store, files)
    return sorted(changed)


# ── a system of record ───────────────────────────────────────────────────────────────────────────

class RecordSystem:
    """A dataset's system of record, opened per call: what ``datasets.projection`` writes through. ``map``
    is derived from the row kind's ``truth`` fields (``datasets.truth``)."""

    def __init__(self, store: Store, map: dict, project_id: str = "", dataset: Any = None) -> None:   # noqa: A002
        self.store, self.map, self.project_id, self.dataset = store, map, project_id, dataset
        self.provider = store.source or store.driver
        self.by = SYSTEM

    @contextlib.asynccontextmanager
    async def _open(self) -> AsyncIterator[Any]:
        if not self.project_id and self.dataset is not None:
            self.project_id = await project_of(self.dataset)
        async with opened(self.store, self.project_id) as source:
            yield source

    @contextlib.asynccontextmanager
    async def _mutable(self, verb: str) -> AsyncIterator[Any]:
        """The driver opened for a write it must be able to make (``Mutable``), refused before any I/O on a
        read-only source."""
        from flow_sdk.sources.protocols import Mutable  # noqa: PLC0415

        if self.store.read_only:
            raise PermissionError(f"{self.provider} is read-only: nothing is {verb}d there")
        async with self._open() as source:
            if not isinstance(source, Mutable):
                raise NotImplementedError(f"the {self.store.driver} driver cannot {verb} a record")
            yield source

    def _written(self, item: Any) -> dict:
        return {**self._flat(item), "warnings": list(item.warnings or [])}

    def _flat(self, item: Any) -> dict:
        """A record as the flat envelope ``truth`` paths read (``external_id``, ``permalink``, ``data.<field>``)."""
        from flow_sdk.ingest.envelope_lift import envelope_of  # noqa: PLC0415

        return envelope_of(item, data_source_id=self.store.label(), provider=self.store.driver).model_dump(mode="json")

    async def records(self) -> list[dict]:
        async with self._open() as source:
            return [self._flat(item) async for item in source.iterate()]

    async def get(self, external_id: Any) -> Optional[dict]:
        from flow_sdk.sources.values.origin import CloudOrigin  # noqa: PLC0415

        if external_id in (None, ""):
            return None
        async with self._open() as source:
            origin = source.origin(str(external_id)) if hasattr(source, "origin") else CloudOrigin(kind="record", namespace="", key=str(external_id))
            item = await source.get(origin)
        return self._flat(item) if item is not None else None

    async def create(self, changes: dict) -> dict:
        from typing import get_type_hints  # noqa: PLC0415

        from flow_sdk.sources.values.items import RecordData  # noqa: PLC0415

        async with self._mutable("create") as source:
            try:   # the record shape the driver's own `create(data: ...)` names
                shape = get_type_hints(type(source).create).get("data", RecordData)
            except Exception:  # noqa: BLE001 -- an annotation that does not resolve: the base record
                shape = RecordData
            shape = shape if isinstance(shape, type) and hasattr(shape, "model_validate") else RecordData
            return self._written(await source.create(shape.model_validate(changes)))

    async def update(self, external_id: str, changes: dict) -> dict:
        async with self._mutable("update") as source:
            return self._written(await source.update(source.origin(str(external_id)), dict(changes)))

    async def delete(self, external_id: str) -> None:
        async with self._mutable("delete") as source:
            await source.delete(source.origin(str(external_id)))


def record_system(dataset: Any) -> Optional[RecordSystem]:
    """The system of record ``dataset``'s rows come from, or None."""
    from flow_sdk.datasets.truth import mirror_map  # noqa: PLC0415

    if not getattr(dataset, "asset_ref", None):
        return None
    store = dataset._rows_store()
    if store.kind != RECORDS:
        return None
    return RecordSystem(store, mirror_map(dataset.row_type.input_type()), dataset=dataset)


# ── one pull, one push, per dataset at a time ────────────────────────────────────────────────────

#: The datasets (by working-copy root) whose rows the current task is already inside a session of.
_inside: contextvars.ContextVar[frozenset] = contextvars.ContextVar("store_inside", default=frozenset())
_locks: Any = None


def _registry() -> Any:
    global _locks
    if _locks is None:
        from flow_sdk.stream_inbox._locks import new_registry  # noqa: PLC0415

        _locks = new_registry()
    return _locks


def inside(root: Path) -> bool:
    return str(root) in _inside.get()


@contextlib.contextmanager
def entered(root: Path) -> Any:
    """Mark ``root``'s rows as inside a session for the duration (a sync caller that pulled itself)."""
    token = _inside.set(_inside.get() | {str(root)})
    try:
        yield
    finally:
        _inside.reset(token)


@contextlib.asynccontextmanager
async def session(dataset: Any, store: Store, *, write: bool) -> AsyncIterator[Path]:
    """Rows for one read or write: pulled first (the store's files, then a system of record's fields),
    and -- for a write -- the working copy's changes pushed after. Nested sessions share the outer one."""
    root = rows_folder(dataset, store)
    if inside(root) or (not store.remote and store.kind != RECORDS):
        yield root
        return
    from flow_sdk.stream_inbox._locks import keyed_loop_lock  # noqa: PLC0415

    async with keyed_loop_lock(_registry(), str(root)):
        from flow_sdk.builtin.dataset import ConflictError  # noqa: PLC0415
        from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

        with entered(root):
            try:
                await pull(dataset, store, root)
                yield root
                if write and store.remote:
                    try:
                        await push(dataset, store, root)
                    except Conflict as exc:
                        raise ConflictError(str(exc)) from exc
            except BaseException:
                if write and store.remote:
                    with contextlib.suppress(Exception):
                        await pull_files_of(dataset, store, root)   # the working copy goes back to what is there
                raise


async def pull_files_of(dataset: Any, store: Store, root: Optional[Path] = None) -> list[str]:
    if not store.remote:
        return []
    async with opened(store.files, await project_of(dataset)) as source:
        return await pull_files(source, root or rows_folder(dataset, store), store)


async def pull(dataset: Any, store: Store, root: Optional[Path] = None) -> dict:
    """Bring the rows up to date: the store's files, then -- for a system of record -- its fields mirrored
    in. ``{"moved": [...], "gone": [...]}``: rows whose record left the system keep their own fields
    (``gone``)."""
    root = root or rows_folder(dataset, store)
    moved = await pull_files_of(dataset, store, root)
    gone: list[str] = []
    if store.kind == RECORDS:
        system = record_system(dataset)
        with entered(root):
            done = await dataset.mirror(await system.records(), system.map, by=SYSTEM, prune="own")
        moved = sorted({*moved, *done.get("created", []), *done.get("updated", []), *done.get("deleted", [])})
        gone = list(done.get("gone", []))
        if store.remote:
            await push(dataset, store, root)
    return {"moved": moved, "gone": gone}


async def push(dataset: Any, store: Store, root: Optional[Path] = None) -> list[str]:
    if not store.remote:
        return []
    async with opened(store.files, await project_of(dataset)) as source:
        return await push_files(source, root or rows_folder(dataset, store), store)


def write_place(folder: Path, source: Any, path: Any) -> None:
    """``dataset.json``'s ``data_source`` / ``path``, rewritten in place (the rest of the file as it was)."""
    from flow_sdk.schema.data_spec.layout import load_doc, write_doc  # noqa: PLC0415

    manifest = folder / "dataset.json"
    metadata, data = load_doc(manifest)
    for key, held in (("data_source", source or None), ("path", path or None)):
        if held is None:
            metadata.pop(key, None)
        else:
            metadata[key] = held
    write_doc(manifest, metadata, data)


# ── moving the rows ──────────────────────────────────────────────────────────────────────────────

def _row_keys(root: Path) -> list[str]:
    """The committed rows of a local rows folder (a row is its folder WITH its ``row.json``)."""
    from flow_sdk.schema.data_spec.layout import ROW_META, _row_dirs  # noqa: PLC0415

    return [p.name for p in _row_dirs(root) if (p / ROW_META).is_file()]


async def move_rows(dataset: Any, source: Any, path: Any = None) -> dict:
    """Copy every row of ``dataset`` into the data source ``source`` (None: the project's data store), check
    it holds them all, then make it where the dataset's rows are (``dataset.json``). A row already there
    under the same key stays as it is there. The old store keeps its rows -- deleting someone's data is
    theirs to decide. Returns ``{"from", "to", "rows"}``."""
    import shutil  # noqa: PLC0415

    old = dataset._rows_store()
    new = resolve(dataset.asset_ref, source, path)
    if new.kind == RECORDS:
        raise ValueError("rows move between data stores; a system of record makes its own records")
    probe = type("_Probe", (), {"data_source": source, "asset_ref": dataset.asset_ref, "project_id": getattr(dataset, "project_id", None)})()
    if why := await readiness(probe):
        raise NotSetUp(f"rows cannot move into {new.label()} yet: {why}")
    if new.key == old.files.key:
        return {"from": old.label(), "to": new.label(), "rows": len(_row_keys(rows_folder(dataset, old)))}
    async with session(dataset, old, write=False) as here:
        keys = set(_row_keys(here))
        target = rows_root(dataset.asset_ref, new, f"{dataset.id}-moving") if new.remote else Path(new.folder)
        if new.remote and target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)
        if new.remote:   # what is there first: the working copy starts as it
            async with opened(new, await project_of(dataset)) as store:
                await pull_files(store, target, new)
        there_before = set(_row_keys(target))
        for key in sorted(keys - there_before):
            shutil.copytree(here / "rows" / key, target / "rows" / key, dirs_exist_ok=True)
        if new.remote:
            async with opened(new, await project_of(dataset)) as store:
                await push_files(store, target, new)
                there = {_row_of(p) for p in await store.list_files() if p.endswith("/row.json")}
        else:
            there = set(_row_keys(target))
        if not keys <= there:
            raise RuntimeError(f"{new.label()} is missing {len(keys - there)} of the {len(keys)} rows after the move: "
                               f"where the rows are was not changed")
    dataset.data_source, dataset.path = source or None, path or None
    write_place(Path(dataset.asset_ref), dataset.data_source, dataset.path)
    if new.remote:   # the new working copy is the one just filled
        final = rows_folder(dataset, new)
        if final.resolve() != target.resolve():
            if final.exists():
                shutil.rmtree(final)
            final.parent.mkdir(parents=True, exist_ok=True)
            target.rename(final)
    await dataset.save()
    return {"from": old.label(), "to": new.label(), "rows": len(there)}
