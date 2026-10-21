"""Where a dataset's rows live -- ``dataset.json`` ``location``.

The app ships the SHAPE (kinds, rules, viewers) and the DRIVERS; the rows live wherever the person
puts them. One field says where::

    "location": "local"                      # default: <dataset>/rows/, kept out of git
    "location": "file:~/data/leads"          # a folder on this machine (rows/ inside it)
    "location": "s3:my-bucket/gtm/leads"     # a driver whose source is ``RowFiles``
    "location": {"driver": "twenty", "config": {"resource": "companies"},
                 "map": {"key": "external_id", "input": {...}}, "by": "crm"}   # a record system

A dataset that lives in a DATA SOURCE names it instead (``"data_source": "gtm-drive"``, optional
``"path": "gtm-personas"`` -- its folder inside the source, the dataset's folder name by default). The
source is the project's ``agentic-assets/data_source/<name>/data_source.json``: its driver and config are
the location's, and a ``location`` object beside ``data_source`` adds the dataset's own part (a record
system's ``config``/``map``/``by``). ``local`` -- the dataset's own ``rows/`` -- is every project's
default source, and where the rows stay while a named source is not set up on this machine
(``readiness``): never an error, and nothing is moved when it is set up later.

A file location (local, a folder, or a ``RowFiles`` driver: Drive, S3) holds the row layout as it is
on disk -- ``rows/<key>/row.json`` and the slot files beside it. A record location (a driver whose
source is ``Mutable`` and listable: Twenty) holds one record per row, shaped by ``map``.

Rows are always READ and WRITTEN through a local folder -- the dataset's own for ``local``, the
named one for ``file:``, and for a remote location a disposable WORKING COPY under this instance
(``<instance>/cache/rows/<dataset id>/``), never a second truth and never in a project. A remote
working copy is brought up to date by ``pull`` and its changes sent by ``push``:

* files: ``row.json`` is a row's COMMIT POINT -- slots are sent first and ``row.json`` last, as a
  write conditioned on the version last seen (``Conflict`` when someone else wrote it since). A row
  folder out there without ``row.json`` is not read (an interrupted write).
* records: a pull re-mirrors every record into the working copy (``Dataset.mirror``); a write goes
  to the record system first (``datasets.projection.write_through``), so there is nothing to push.
"""

from __future__ import annotations

import asyncio
import contextlib
import contextvars
import functools
import hashlib
import json
import logging
import os
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, AsyncIterator, Callable, Optional

logger = logging.getLogger(__name__)

LOCAL, FOLDER, FILES, RECORDS = "local", "folder", "files", "records"
_DRIVER = re.compile(r"^([a-z][a-z0-9_]*):(.*)$")
#: The working copy's own record of what it last saw out there: ``{path: {"v": version, "h": hash}}``.
STATE_FILE = ".location.json"
#: How many files a pull reads at once.
PULL_CONCURRENCY = 8


@dataclass(frozen=True)
class Location:
    kind: str
    driver: str = ""
    target: str = ""
    config: dict = field(default_factory=dict)
    map: Optional[dict] = None
    by: Optional[str] = None
    read_only: bool = False
    raw: Any = None
    #: The data source the location is resolved from ("" for one written inline), and the rows'
    #: folder inside it.
    source: str = ""
    path: str = ""

    @property
    def remote(self) -> bool:
        return self.kind in (FILES, RECORDS)

    def label(self) -> str:
        """How the location reads to a person (and in a log)."""
        if self.kind == LOCAL:
            return LOCAL
        if self.kind == FOLDER:
            return f"file:{self.target}"
        if self.source:
            return f"{self.source} · {self.path}" if self.path else self.source
        return f"{self.driver}:{self.target}" if self.target else self.driver


def parse(value: Any) -> Location:
    """A ``location`` as written in ``dataset.json`` → ``Location``; ``ValueError`` naming what is wrong."""
    if value in (None, "", LOCAL):
        return Location(LOCAL, raw=LOCAL)
    if isinstance(value, str):
        if value.startswith("file:"):
            path = value[len("file:"):].strip()
            if not path:
                raise ValueError("location: file: needs a folder (file:~/data/leads)")
            return Location(FOLDER, target=str(Path(path).expanduser()), raw=value)
        found = _DRIVER.match(value.strip())
        if not found:
            raise ValueError(f"location: {value!r} is not local, file:<folder> or <driver>:<target>")
        return Location(FILES, driver=found.group(1), target=found.group(2).strip(), raw=value)
    if isinstance(value, dict):
        unknown = set(value) - {"driver", "target", "config", "map", "by", "read_only", "source", "path"}
        if unknown or not isinstance(value.get("driver"), str) or not _DRIVER.match(f"{value['driver']}:"):
            raise ValueError('location: {"driver", "target"?, "config"?, "map"?, "by"?, "read_only"?} is required')
        config = {} if value.get("config") is None else value["config"]
        if not isinstance(config, dict):
            raise ValueError("location.config: an object is required")
        shape = value.get("map")
        if shape is not None:
            from flow_sdk.datasets.projection import check_map  # noqa: PLC0415

            check_map(shape)
        by = value.get("by")
        if by is not None and not isinstance(by, str):
            raise ValueError("location.by: one word, as a schema's `owned_by` (\"crm\")")
        return Location(RECORDS if shape is not None else FILES, driver=value["driver"], target=str(value.get("target") or ""),
                        config=dict(config), map=shape, by=by, read_only=bool(value.get("read_only")), raw=value,
                        source=str(value.get("source") or ""), path=str(value.get("path") or "").strip("/"))
    raise ValueError("location: a string or an object is required")


# ── a dataset's data source ──────────────────────────────────────────────────────────────────────

def _project_of_folder(folder: Path | str) -> Optional[Path]:
    """The project a dataset folder sits in (the folder above its ``agentic-assets``), or None."""
    return next((parent.parent for parent in Path(folder).parents if parent.name == "agentic-assets"), None)


@functools.lru_cache(maxsize=256)
def _source_spec(manifest: str, mtime_ns: int) -> tuple[str, dict]:
    """``(driver, config)`` of one ``data_source.json`` as ``DataSourceSpec`` reads it -- cached per file version."""
    from flow_sdk.schema.data_spec.data_source_spec import DataSourceSpec  # noqa: PLC0415
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    whole = load_json_dict(Path(manifest))
    spec = DataSourceSpec.model_validate(whole["metadata"] if isinstance(whole.get("metadata"), dict) else whole)
    return spec.provider, dict(spec.config)


def source_document(folder: Path | str, name: str) -> dict:
    """``data_source.json`` of the source ``name`` in the project of the dataset in ``folder``, as
    ``{"provider", "config"}``; ``ValueError`` naming what is missing."""
    root = _project_of_folder(folder)
    manifest = root / "agentic-assets" / "data_source" / name / "data_source.json" if root else None
    if manifest is None or not manifest.is_file():
        raise ValueError(f"data_source: the project has no data source {name!r} (agentic-assets/data_source/{name}/)")
    provider, config = _source_spec(str(manifest), manifest.stat().st_mtime_ns)
    if not provider:
        raise ValueError(f"data_source: {name!r} names no driver")
    return {"provider": provider, "config": dict(config)}


def declared(folder: Path | str, source: Any, path: Any, location: Any) -> Any:
    """The location value a dataset declares: its ``location`` alone, or the data source it names
    resolved into one (the source's driver and config, the dataset's own ``location`` object on top)."""
    if source in (None, "", LOCAL):
        return location
    found = source_document(folder, str(source))
    own = location if isinstance(location, dict) else {}
    value: dict = {"driver": found["provider"], "config": {**found["config"], **(own.get("config") or {})}, "source": str(source)}
    for key in ("map", "by", "read_only"):
        if own.get(key) is not None:
            value[key] = own[key]
    if own.get("map") is None:
        value["path"] = str(path or own.get("target") or Path(folder).name).strip("/")
    return value


#: What a named source answered for a dataset in this process: ``{(dataset folder, source): why}``, ``""``
#: when the rows are in it. Filled by ``readiness`` (async: it asks the source's row).
_checked: dict[tuple[str, str], str] = {}


def held_back(folder: Path | str, source: Any) -> Optional[str]:
    """Why the rows of the dataset in ``folder`` stay local instead of in ``source`` -- ``""`` when
    they are in it, None when the source has not been asked yet in this process (the rows read as local)."""
    if source in (None, "", LOCAL):
        return ""
    return _checked.get((str(folder), str(source)))


def effective(folder: Path | str, source: Any, path: Any, location: Any) -> Location:
    """Where a dataset's rows are NOW: its declared place, or the default local one while its source has
    not said it can hold them. The one rule every reader and writer of the rows uses."""
    if held_back(folder, source) != "":
        return parse(None) if source not in (None, "", LOCAL) else parse(location)
    return parse(declared(folder, source, path, location))


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


def remember(folder: Path | str, source: Any, why: str) -> None:
    _checked[(str(folder), str(source))] = why


async def readiness(dataset: Any, *, cached: bool = False) -> str:
    """Ask the dataset's source whether it can hold the rows now, and remember the answer for the
    sync paths (``held_back``). ``""`` when the rows are in the source; else why they stay local.
    ``cached``: an answer already given in this process stands (a source's verify refreshes it)."""
    source = getattr(dataset, "data_source", None)
    if source in (None, "", LOCAL) or not getattr(dataset, "asset_ref", ""):
        return ""
    if cached and (held := held_back(dataset.asset_ref, source)) is not None:
        return held
    try:
        why = await source_refusal(str(source), await project_of(dataset))
    except Exception as exc:  # noqa: BLE001 -- an index that cannot answer keeps the rows local, never fails a read
        why = f"{source} could not be checked ({exc})"
    remember(dataset.asset_ref, source, why)
    return why


async def refresh_hosted(source: Any, datasets: Optional[list] = None) -> None:
    """Every dataset ``source`` hosts takes the source's answer -- asked once -- and its row says where its
    rows are now."""
    datasets = await source.datasets() if datasets is None else datasets
    if not datasets:
        return
    try:
        why = await source_refusal(str(source.name), str(getattr(source, "project_id", "") or ""))
    except Exception as exc:  # noqa: BLE001 -- the check never fails over a note
        why = f"{source.name} could not be checked ({exc})"
    unfilled = []
    for dataset in datasets:
        if getattr(dataset, "asset_ref", ""):
            remember(dataset.asset_ref, source.name, why)
            await dataset.note_where_rows_are()
            if not why:
                unfilled.append(dataset)
    if unfilled:   # behind the check, never in it: a big dataset's first pull takes minutes
        task = asyncio.create_task(_first_pulls(unfilled))
        _filling.add(task)
        task.add_done_callback(_filling.discard)


async def refresh_all_hosted() -> None:
    """Every source that hosts datasets answers once -- at startup, so no dataset reads as local only
    because this process has not asked its source yet. Reads the source rows only; no network."""
    from flow_sdk.builtin.data_source import DataSource  # noqa: PLC0415
    from flow_sdk.builtin.dataset import Dataset  # noqa: PLC0415
    from flow_sdk.db.drivers.query import ExpressionNode, QueryFilter, QueryOp  # noqa: PLC0415

    # Only the sources some dataset names: ask the datasets, then look those sources up by name.
    in_source = QueryFilter(match=ExpressionNode(op=QueryOp.IS_NOT_NULL, operands=["data_source"]))
    names = sorted({str(d.data_source) for d in await Dataset.get_all(in_source) or [] if getattr(d, "data_source", None)})
    sources = [s for name in names for s in await DataSource.get_all({"name": name}) or []]
    for source in sources:
        try:
            if hosted := await source.datasets():
                await refresh_hosted(source, hosted)
        except Exception:  # noqa: BLE001 -- one source never holds up the rest
            logger.warning("data source %s: could not tell its datasets where their rows are",
                           getattr(source, "name", ""), exc_info=True)

#: The first-pull passes running now (held so a task is not collected mid-run).
_filling: set = set()


async def _first_pulls(datasets: list) -> None:
    for dataset in datasets:
        await _first_pull(dataset)


async def _first_pull(dataset: Any) -> None:
    """A dataset whose working copy was never filled gets it now: another dataset's links read these
    rows from disk (``links._row_ids``) without a session of their own."""
    location = dataset._location()
    if not location.remote or (rows_folder(dataset, location) / STATE_FILE).is_file():
        return
    try:
        async with session(dataset, location, write=False):
            pass
        await dataset.refresh_counts()
    except Exception:  # noqa: BLE001 -- the next session of that dataset pulls it anyway
        logger.warning("dataset %s: first pull from %s failed", getattr(dataset, "name", ""), location.label(), exc_info=True)


def rows_root(folder: Path | str, location: Location, dataset_id: str) -> Path:
    """The local folder whose ``rows/`` the row code reads and writes, for the dataset in ``folder``."""
    if location.kind == LOCAL:
        return Path(folder)
    if location.kind == FOLDER:
        return Path(location.target)
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return get_instance_settings().instance_dir / "cache" / "rows" / (dataset_id or _digest(str(folder).encode()))


def rows_folder(dataset: Any, location: Location) -> Path:
    return rows_root(dataset.asset_ref, location, str(dataset.id or ""))


def rows_root_of(folder: Path | str, header: Optional[dict] = None, dataset_id: Optional[str] = None) -> Path:
    """``rows_root`` for a dataset read from disk alone: its ``location`` from ``header`` (the
    manifest's metadata) or from ``dataset.json``, its id from the folder's identity. A location that
    does not parse reads as local (the dataset's own folder): a bad manifest never moves the rows."""
    folder = Path(folder)
    if header is None:
        from flow_sdk.schema.data_spec.layout import load_doc  # noqa: PLC0415

        header = load_doc(folder / "dataset.json")[0]
    try:
        location = effective(folder, header.get("data_source"), header.get("path"), header.get("location"))
    except ValueError:
        return folder
    if location.kind == LOCAL:
        return folder
    if dataset_id is None and location.remote:
        from flow_sdk.schema.data_spec.io.identity import FolderCapsule  # noqa: PLC0415

        dataset_id = FolderCapsule().read(folder) or ""
    return rows_root(folder, location, dataset_id or "")


# ── opening a driver as a store ───────────────────────────────────────────────────────────────────

#: A test double's seam: ``(location) -> async context manager yielding the opened source``.
OPENER: Optional[Callable[[Location], Any]] = None


async def project_of(dataset: Any) -> str:
    """The id of the project a dataset belongs to: where the location's driver finds the credential its
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
async def opened(location: Location, project_id: str = "") -> AsyncIterator[Any]:
    """The location's driver, configured and opened, as its source (``RowFiles`` or ``Mutable``).
    Credentials come from what the driver's manifest names, as for any source of it, looked up in
    ``project_id``'s scope (then the user's)."""
    if OPENER is not None:
        async with OPENER(location) as source:
            yield source
        return
    from flow_sdk.builtin.data_driver import DataDriver  # noqa: PLC0415

    driver = await DataDriver.get(location.driver)
    config = dict(location.config)
    if location.path:
        within = getattr(driver.cls, "rows_within", None)
        if within is None:
            raise ValueError(f"data_source: the {location.driver} driver cannot hold a dataset's rows in a folder")
        config = within(config, location.path)
    elif location.target:
        target_of = getattr(driver.cls, "row_files_target", None)
        if target_of is None:
            raise ValueError(f"location: the {location.driver} driver cannot hold rows at {location.target!r}")
        config.update(target_of(location.target))
    source = driver.create_source(config, name=f"rows at {location.label()}", **({"project_id": project_id} if project_id else {}))
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


def _seen(root: Path, location: Location) -> dict:
    """What the working copy last saw at ``location``: ``{path: {"v": version, "h": hash}}`` -- empty
    for a copy of another location (or none yet)."""
    from flow_sdk.schema.data_spec.layout import load_json_dict  # noqa: PLC0415

    state = load_json_dict(root / STATE_FILE)
    files = state.get("files")
    return files if state.get("location") == location.raw and isinstance(files, dict) else {}


def _save_state(root: Path, location: Location, files: dict) -> None:
    from flow_sdk.instances.atomic import write_json_atomic  # noqa: PLC0415

    root.mkdir(parents=True, exist_ok=True)
    write_json_atomic(root / STATE_FILE, {"location": location.raw, "files": files})


async def pull_files(store: Any, root: Path, location: Location) -> list[str]:
    """Make the working copy ``root`` hold exactly what the store holds: a file changed out there,
    or changed here without being pushed, is read again; one gone out there goes here. A row out
    there without ``row.json`` is skipped. Returns the keys of the rows that moved."""
    seen = _seen(root, location)
    remote = await store.list_files()
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
            data = await store.read_file(path)
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
    _save_state(root, location, files)
    return sorted(k for k in moved if k)


def _prune_empty(base: Path) -> None:
    if not base.is_dir():
        return
    for here, dirs, files in os.walk(base, topdown=False):
        path = Path(here)
        if path != base and not any(path.iterdir()):
            path.rmdir()


async def push_files(store: Any, root: Path, location: Location) -> list[str]:
    """Send what changed in the working copy since the last pull or push: per row, its slot files
    first and ``row.json`` LAST, conditioned on the version last seen; a row gone here goes out
    there, ``row.json`` last again. ``Conflict`` when another writer moved a row since -- what was
    sent of that row stays out there, and the caller pulls. Returns the keys sent."""
    from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

    seen = _seen(root, location)
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
    remote = await store.list_files()
    files = dict(seen)
    for key, paths in sorted(changed.items()):
        meta = f"rows/{key}/row.json"
        expected = (seen.get(meta) or {}).get("v", "")
        if remote.get(meta, "") != expected:
            raise Conflict(f"row {key!r} changed at {location.label()} since it was read")
        gone = meta not in local
        for path, data in sorted(paths.items()):
            if path == meta:
                continue
            if data is None:
                await store.delete_file(path)
                files.pop(path, None)
            else:
                files[path] = {"v": await store.write_file(path, data), "h": _digest(data)}
        if gone:
            # the rest of the row folder goes too: files here never seen are not ours to keep
            for path in [p for p in remote if _row_of(p) == key and p != meta and p not in paths]:
                await store.delete_file(path)
                files.pop(path, None)
            if meta in remote:
                await store.delete_file(meta, expected=expected)
            files.pop(meta, None)
        else:
            data = local[meta]
            files[meta] = {"v": await store.write_file(meta, data, expected=expected), "h": _digest(data)}
    _save_state(root, location, files)
    return sorted(changed)


# ── records ──────────────────────────────────────────────────────────────────────────────────────

class RecordSystem:
    """A record location, opened per call: what ``datasets.projection`` writes through."""

    def __init__(self, location: Location, project_id: str = "", dataset: Any = None) -> None:
        self.location, self.project_id, self.dataset = location, project_id, dataset
        self.provider = location.driver
        self.map = location.map or {}
        self.by = location.by or location.driver

    @contextlib.asynccontextmanager
    async def _open(self) -> AsyncIterator[Any]:
        """The driver opened in the dataset's project (found once, on first use)."""
        if not self.project_id and self.dataset is not None:
            self.project_id = await project_of(self.dataset)
        async with opened(self.location, self.project_id) as source:
            yield source

    def _writable(self, verb: str) -> None:
        if self.location.read_only:
            raise PermissionError(f"these rows are read-only: nothing is {verb}d in {self.provider}")

    @contextlib.asynccontextmanager
    async def _mutable(self, verb: str) -> AsyncIterator[Any]:
        """The driver opened for a write it must be able to make (``Mutable``), refused before any I/O
        on a read-only location."""
        from flow_sdk.sources.protocols import Mutable  # noqa: PLC0415

        self._writable(verb)
        async with self._open() as source:
            if not isinstance(source, Mutable):
                raise NotImplementedError(f"the {self.provider} driver cannot {verb} a record")
            yield source

    def _written(self, item: Any) -> dict:
        return {**self._flat(item), "warnings": list(item.warnings or [])}

    def _flat(self, item: Any) -> dict:
        """A record as the flat envelope ``map`` paths read (``external_id``, ``name``, ``data.<field>``)."""
        from flow_sdk.ingest.envelope_lift import envelope_of  # noqa: PLC0415

        return envelope_of(item, data_source_id=self.location.label(), provider=self.provider).model_dump(mode="json")

    async def records(self) -> list[dict]:
        """Every record, flat (``external_id``, ``data.<field>``): what ``map`` paths read."""
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


# ── one pull, one push, per dataset at a time ────────────────────────────────────────────────────

#: The datasets (by working-copy root) whose rows the current task is already inside a session of:
#: an inner read or write does not pull again, and the outermost session pushes.
_inside: contextvars.ContextVar[frozenset] = contextvars.ContextVar("location_inside", default=frozenset())
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
async def session(dataset: Any, location: Location, *, write: bool) -> AsyncIterator[Path]:
    """Rows of a remote location for one read or write: pulled first, and -- for a write -- the
    working copy's changes pushed after. Nested sessions on one dataset share the outer one."""
    root = rows_folder(dataset, location)
    if not location.remote or inside(root):
        yield root
        return
    from flow_sdk.stream_inbox._locks import keyed_loop_lock  # noqa: PLC0415

    async with keyed_loop_lock(_registry(), str(root)):
        from flow_sdk.builtin.dataset import ConflictError  # noqa: PLC0415
        from flow_sdk.sources.errors import Conflict  # noqa: PLC0415

        with entered(root):
            try:
                await pull(dataset, location, root)
                yield root
                if write and location.kind == FILES:
                    try:
                        await push(dataset, location, root)
                    except Conflict as exc:
                        raise ConflictError(str(exc)) from exc
            except BaseException:
                if write and location.kind == FILES:
                    with contextlib.suppress(Exception):
                        await pull(dataset, location, root)   # the working copy goes back to what is out there
                raise


async def pull(dataset: Any, location: Location, root: Optional[Path] = None) -> list[str]:
    root = root or rows_folder(dataset, location)
    if location.kind == FILES:
        async with opened(location, await project_of(dataset)) as store:
            return await pull_files(store, root, location)
    if location.kind == RECORDS:
        system = RecordSystem(location, dataset=dataset)
        _check_owned(dataset, system)
        with entered(root):
            done = await dataset.mirror(await system.records(), system.map, by=system.by)
        return sorted({*done.get("created", []), *done.get("updated", []), *done.get("deleted", [])})
    return []


def _check_owned(dataset: Any, system: RecordSystem) -> None:
    """A mapped field is rewritten from the record on every pull. One the schema lets the app write
    too would take an edit and lose it at the next pull -- so the map may only name fields the schema
    says are this system's (``owned_by``): an edit to one goes to the system first."""
    from flow_sdk.builtin.dataset import LinkError  # noqa: PLC0415

    owned = getattr(dataset.row_type.input_type(), "__owned__", None) or {}
    loose = [name for name in system.map.get("input", {}) if owned.get(name) != system.by]
    if loose:
        raise LinkError([{"path": "", "code": "not_owned",
                          "message": f"the location's map writes {', '.join(loose)} as {system.by!r}, but the row kind "
                                     f'does not say `"owned_by": "{system.by}"` on {"it" if len(loose) == 1 else "them"}: '
                                     f"an edit made here would be lost at the next pull"}])


async def push(dataset: Any, location: Location, root: Optional[Path] = None) -> list[str]:
    if location.kind != FILES:
        return []
    async with opened(location, await project_of(dataset)) as store:
        return await push_files(store, root or rows_folder(dataset, location), location)


def _write_location(folder: Path, value: Any, source: Any = None, path: Any = None) -> None:
    """``dataset.json``'s ``location`` / ``data_source`` / ``path``, rewritten in place (the rest of the file
    as it was)."""
    from flow_sdk.schema.data_spec.layout import load_doc, write_doc  # noqa: PLC0415

    manifest = folder / "dataset.json"
    metadata, data = load_doc(manifest)
    for key, held in (("location", None if value in (None, LOCAL) else value),
                      ("data_source", None if source in (None, "", LOCAL) else source), ("path", path or None)):
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


def _target_of(dataset: Any, value: Any) -> tuple[Location, Any, Any]:
    """A move's target: a location value, or ``{"data_source", "path"?}`` naming a data source."""
    if isinstance(value, dict) and value.get("data_source") is not None and set(value) <= {"data_source", "path"}:
        source, path = value["data_source"], value.get("path")
        return parse(declared(dataset.asset_ref, source, path, None)), source, path
    return parse(value), None, None


async def move_rows(dataset: Any, value: Any) -> dict:
    """Copy every row of ``dataset`` to ``value`` (a location, or ``{"data_source", "path"?}``), check it
    holds them all, then make it where the dataset's rows are (``dataset.json``). Rows already there
    are ADOPTED: they stay and become the dataset's too; a key on both sides keeps the copy that is
    there (listed as ``conflicts``). The old location keeps its rows -- deleting someone's data is
    theirs to decide. A record system is refused: its records are made by the system, not copied in.
    Returns ``{"from", "to", "rows", "adopted", "conflicts"}``."""
    import shutil  # noqa: PLC0415

    old = dataset._location()
    new, source, path = _target_of(dataset, value)
    if source not in (None, "", LOCAL) and (why := await source_refusal(str(source), await project_of(dataset))):
        raise ValueError(f"rows cannot move into {source} yet: {why}")
    if new.kind == RECORDS:
        raise ValueError("rows move between file locations (local, a folder, Drive, S3); a record system makes its own records")
    if new.label() == old.label():
        n = len(_row_keys(rows_folder(dataset, old)))
        return {"from": old.label(), "to": new.label(), "rows": n, "adopted": 0, "conflicts": []}
    async with session(dataset, old, write=False) as here:
        keys = set(_row_keys(here))
        target = rows_root(dataset.asset_ref, new, f"{dataset.id}-{_digest(json.dumps(new.raw, sort_keys=True).encode())}" if new.remote else str(dataset.id))
        if new.remote and target.exists():
            shutil.rmtree(target)
        target.mkdir(parents=True, exist_ok=True)
        if new.kind == FILES:   # what is out there first: the working copy starts as it
            async with opened(new, await project_of(dataset)) as store:
                await pull_files(store, target, new)
        there_before = set(_row_keys(target)) if target.resolve() != here.resolve() else set()
        conflicts = sorted(keys & there_before)
        if target.resolve() != here.resolve():
            for key in sorted(keys - there_before):
                shutil.copytree(here / "rows" / key, target / "rows" / key, dirs_exist_ok=True)
        if new.kind == FILES:
            async with opened(new, await project_of(dataset)) as store:
                await push_files(store, target, new)
                there = {_row_of(p) for p in await store.list_files() if p.endswith("/row.json")}
        else:
            there = set(_row_keys(target))
        if not keys <= there:
            raise RuntimeError(f"{new.label()} is missing {len(keys - there)} of the {len(keys)} rows after the move: "
                               f"where the rows are was not changed")
    if source is not None:
        dataset.data_source, dataset.path, dataset.location = source, path, None
    else:
        dataset.data_source, dataset.path = None, None
        dataset.location = None if new.kind == LOCAL else new.raw
    _write_location(Path(dataset.asset_ref), dataset.location, dataset.data_source, dataset.path)
    if new.remote:   # the new working copy is the one just filled
        final = rows_folder(dataset, new)
        if final.resolve() != target.resolve():
            if final.exists():
                shutil.rmtree(final)
            final.parent.mkdir(parents=True, exist_ok=True)
            target.rename(final)
        if source is not None:   # moved there means it holds rows here: no need to ask again first
            remember(dataset.asset_ref, source, "")
    await dataset.save()
    return {"from": old.label(), "to": new.label(), "rows": len(there), "adopted": len(there_before),
            "conflicts": conflicts}


# ── the gate: rows are data, not the project's code ──────────────────────────────────────────────

def tracked_rows(project_root: Path | str) -> list[str]:
    """The row files git tracks under ``<project>/agentic-assets/dataset/*/rows/`` -- what must be
    empty for a project that ships shape, not data. ``[]`` outside a repo."""
    import subprocess  # noqa: PLC0415

    from flow_sdk.utils.git_usable import git_usable  # noqa: PLC0415

    if not git_usable():
        return []
    try:
        listed = subprocess.run(["git", "ls-files", "-z", "--", "agentic-assets/dataset/*/rows/*"],
                                cwd=str(project_root), capture_output=True, check=False, timeout=30)
    except (OSError, subprocess.SubprocessError):
        return []
    if listed.returncode != 0:
        return []
    return sorted(p for p in listed.stdout.decode("utf-8", "replace").split("\0") if p)
