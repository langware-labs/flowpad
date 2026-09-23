"""DataDriver — a data source driver: the code and manifest that know how to talk to a system.

``agentic-assets/data_driver/<name>/`` holds ``data_driver.json`` (the ``DataDriverSpec``) and
``source.py`` (the one ``Source`` subclass). A ``DataSource`` is one configured instance of a driver,
its own asset. The split is the one the codebase already makes twice: ``GraphWorkflow`` is the
definition and ``GraphWorkflowRun`` the execution; a driver's file never churns, a source's row does.

One class for the indexed row and the loaded driver. The row (a ``data_driver.json`` the indexer
read) carries the manifest's fields; a LOADED driver also holds its class, manifest and folder —
``DataDriver.loaded(name)`` / ``await DataDriver.get(name)`` return it, and the run-time verbs
(``open``, ``traverse``, ``send``, ``verify``) come from ``DriverRuntime``::

    driver = await DataDriver.get("rss")
    source = driver.create_source({"feed_url": url}, name="news")  # unsaved
    await source.save()                                               # writes data_source.json
"""
from __future__ import annotations

from functools import cache
from pathlib import Path
from typing import ClassVar, Optional

from pydantic import PrivateAttr, computed_field

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.ingest.driver_runtime import DRIVERS, DriverRuntime
from flow_sdk.schema.data_spec.data_driver_spec import (
    CURRENT_SCHEMA,
    AuthSpec,
    CallStart,
    DataDriverSpec,
    FieldHints,
    Runtime,
)
from flow_sdk.schema.types import EntityType
from flow_sdk.sources.base import Source
from flow_sdk.sources.config import SourceConfig


class DataDriver(DriverRuntime, Entity):
    """The ROW; its shape on disk is ``DataDriverSpec`` (``TypeInfo.asset_spec``). The folder beside
    the manifest holds the source's own code (``source.py``), loaded by the source registry."""

    type: str = APIField(default=EntityType.DATA_DRIVER.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's, and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # ── the header, held as entity fields ──
    title: str = APIField(default="")
    description: str = APIField(default="")
    kind: str = APIField(default="")
    ns: str = APIField(
        default="",
        description=(
            "Whose ontology this driver's kinds belong to. Blank is OURS — the "
            "flow namespace is the default and it is silent. An externally "
            "authored driver names itself here and every kind it mints is "
            "prefixed `--<ns>--`."
        ),
    )
    icon_name: str = APIField(default="")
    channel_icon_names: dict[str, str] = APIField(default_factory=dict)
    setup_wiki: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    requires: dict[str, str] = APIField(default_factory=dict)
    auth: Optional[AuthSpec] = APIField(default=None)
    reflect: list[str] = APIField(default_factory=list)
    config: dict[str, FieldHints] = APIField(default_factory=dict)
    listed: bool = APIField(default=True)
    provisioned: bool = APIField(default=False)
    #: How a person starts a call on it: ``webrtc`` | ``clip`` | ``dial``; blank takes no calls.
    calls: CallStart = APIField(default=CallStart.NONE)

    #: DERIVED from the folder by the extractor (``DataDriverSpec.runtime_for_folder``), never
    #: authored; mirrored to the shadow.
    runtime: str = APIField(default=Runtime.SOURCE.value, persist=Persist.TRUE)

    _api_visible: ClassVar[bool] = True

    # ── a LOADED driver (``for_class``); None / empty on a row read from the index ──
    _cls: Optional[type[Source]] = PrivateAttr(default=None)
    _manifest: Optional[DataDriverSpec] = PrivateAttr(default=None)
    _folder: Optional[Path] = PrivateAttr(default=None)
    _content_hash: str = PrivateAttr(default="")
    _shipped: bool = PrivateAttr(default=False)

    def __setattr__(self, name: str, value) -> None:
        """A loaded driver's verb may be replaced on the one instance (a test double's ``send``, a
        stubbed ``credentials_for``); everything else is a model field."""
        if name in _VERBS:
            object.__setattr__(self, name, value)
            return
        super().__setattr__(name, value)

    @classmethod
    def for_class(
        cls,
        source_cls: type[Source],
        manifest: Optional[DataDriverSpec] = None,
        *,
        kind: str = "",
        folder: Optional[Path] = None,
        content_hash: str = "",
        shipped: bool = False,
        **fields,
    ) -> "DataDriver":
        """A driver for ``source_cls``: the loader builds one per folder, a test one per double. Not
        registered — ``DataDriver.register`` does that."""
        header = manifest.model_dump(exclude={"name"}, exclude_unset=True) if manifest is not None else {}
        header = {k: v for k, v in header.items() if k in cls.model_fields}
        kind = kind or (manifest.kind if manifest is not None and manifest.kind else f"datasource.{source_cls.provider}")
        driver = cls(**{**header, **fields, "name": source_cls.provider, "kind": kind})
        driver._cls, driver._manifest, driver._folder = source_cls, manifest, folder
        driver._content_hash, driver._shipped = content_hash, shipped
        return driver

    @classmethod
    def loaded(cls, name: str) -> Optional["DataDriver"]:
        """The registered driver for ``name``, or None. An authored folder not loaded yet is a miss
        here; ``await DataDriver.get(name)`` loads it."""
        return DRIVERS.get_or_none(name or "")

    @classmethod
    async def get(cls, name: str) -> Optional["DataDriver"]:
        """The driver for ``name``: registered, or an authored folder loaded now from its indexed row
        (again when its code changed since)."""
        from flow_sdk.ingest.driver_registry import resolve  # noqa: PLC0415

        return await resolve(name)

    @classmethod
    def register(cls, driver: "DataDriver") -> "DataDriver":
        return DRIVERS.register(driver)

    @computed_field
    @property
    def sends(self) -> bool:
        """Whether a source of this driver is a MessageSource — its class can push a reply back to the
        channel.

        Computed at serialization, not derived by the indexer like ``runtime``: the answer lives on
        the source CLASS, and importing source code from inside the indexer's per-record sync
        deadlocks on the import lock. By the time a row reaches the wire the shipped drivers are
        loaded, so this is a dict lookup. A driver nothing has registered answers False — the same
        answer the poller gives, which reports it as ``unknown_provider``.
        """
        driver = self._loaded()
        return bool(driver is not None and driver.can_send)

    @computed_field
    @property
    def load_error(self) -> str:
        """Why this folder's source did not load (no ``source.py``, an import error, a name a
        shipped source owns), or ``""``."""
        from flow_sdk.ingest.driver_registry import load_error_for  # noqa: PLC0415

        return load_error_for(self.name or "")

    @computed_field
    @property
    def config_schema(self) -> dict:
        """The JSON Schema of this driver's ``Config`` — the form's rules (required, pattern, type);
        ``config`` holds only its hints. ``{}`` for a driver that declares none."""
        return _schema_of(self.config_cls) if self.config_cls is not None else {}

    @property
    def config_cls(self) -> Optional[type[SourceConfig]]:
        """The loaded driver's ``Config``, or None (not loaded, or a test double with none)."""
        driver = self._loaded()
        return getattr(driver.cls, "Config", None) if driver is not None else None

    def create_config(self, **fields) -> SourceConfig:
        """This driver's config, typed and validated (``Config.validated``): a ``ValueError`` names the
        field at fault. Optional before ``create_source``, which also takes a plain dict."""
        if self.config_cls is None:
            raise TypeError(f"the {self.name} driver declares no Config")
        return self.config_cls.validated(fields)

    def coerce_config(self, config: dict) -> dict:
        """A config as a person typed it, shaped by the ``Config``: what validates replaces what was typed."""
        return {**config, **self.config_cls.draft(config)} if self.config_cls is not None else dict(config)

    def config_of(self, source) -> dict:
        """A stored source's config, read as well as it still validates."""
        raw = dict(getattr(source, "config", None) or {})
        return self.config_cls.best_match(raw) if self.config_cls is not None else raw

    def _loaded(self) -> Optional["DataDriver"]:
        """This driver when it is the loaded one; for a row read from the index, the registered driver."""
        return self if self._cls is not None else DataDriver.loaded(self.name or "")


#: The run-time verbs a single driver instance may have replaced (a test's stub); computed once.
_VERBS = frozenset(
    name for name, value in vars(DriverRuntime).items() if callable(value) and not name.startswith("__")
)


@cache
def _schema_of(config_cls: type[SourceConfig]) -> dict:
    """A ``Config``'s JSON Schema, built once per class — a list request serializes every driver row."""
    return config_cls.model_json_schema()
