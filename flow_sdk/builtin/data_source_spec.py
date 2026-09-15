"""DataSourceSpec — the authored half of a data source.

``DataSource`` is a configured instance: a credential binding, a schedule, a
health verdict, cursors. All of that is machine-local and changes every minute.
``DataSourceSpec`` is what a source *is* — a folder asset carrying the manifest,
and nothing that churns.

The split is the same one the codebase already makes twice: ``GraphWorkflow`` is
the definition and ``GraphWorkflowRun`` the execution. Folding them together
here would put ``health`` and ``next_poll_at`` in a file on disk, rewritten on
every poll — a diff a minute in any git-tracked project.

It also makes one spec serve many bindings: one "internal wiki" definition, two
tenants, and a team that shares the definition while each person supplies their
own credential.

``ManifestSpec`` is the type's ``asset_spec``: the shape of ``data_source.json``,
read and written by the disk serializer like any other folder asset's main doc
(flat, because the spec declares no ``FreeSection``). Every rule about what a
manifest may say is a validator here — a load ERROR, never a warning, because
each silent version produced a real bug: a second owner for a fact the driver
already declares, a picker offering a mode that cannot work.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import computed_field

from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.data_source_manifest_spec import (
    CURRENT_SCHEMA,
    AuthSpec,
    ConfigFieldSpec,
    Runtime,
    coerce_config,
)
from flow_sdk.schema.types import EntityType

#: The manifest format this build reads. A manifest that says otherwise is a
#: load error, not a best-effort parse.































class DataSourceSpec(Entity):
    """The ROW; its shape on disk is ``ManifestSpec`` (``TypeInfo.asset_spec``). The folder beside
    the manifest holds the source's own code (``source.py``), loaded by the source registry."""

    type: str = APIField(default=EntityType.DATA_SOURCE_SPEC.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's, and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # ── the header, held as entity fields ──
    title: str = APIField(default="")
    description: str = APIField(default="")
    kind: str = APIField(default="")
    icon_name: str = APIField(default="")
    channel_icon_names: dict[str, str] = APIField(default_factory=dict)
    setup_wiki: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    requires: dict[str, str] = APIField(default_factory=dict)
    auth: Optional[AuthSpec] = APIField(default=None)
    reflect: list[str] = APIField(default_factory=list)
    config: dict[str, ConfigFieldSpec] = APIField(default_factory=dict)
    listed: bool = APIField(default=True)
    provisioned: bool = APIField(default=False)

    #: DERIVED from the folder by the extractor (``ManifestSpec.runtime_for_folder``), never
    #: authored; mirrored to the shadow.
    runtime: str = APIField(default=Runtime.SOURCE.value, persist=Persist.TRUE)

    _api_visible: ClassVar[bool] = True

    @computed_field
    @property
    def sends(self) -> bool:
        """Whether a source of this provider is a MessageSource — its class can push a reply back
        to the channel (``SourceType.sends``).

        Computed at serialization, not derived by the indexer like ``runtime``: the answer lives on
        the source CLASS, and importing source code from inside the indexer's per-record sync
        deadlocks on the import lock. By the time a row reaches the wire the shipped sources are
        loaded, so this is a dict lookup. A provider nothing has registered answers False — the same
        answer the poller gives, which reports it as ``unknown_provider``.
        """
        from flow_sdk.ingest.sources import source_type  # noqa: PLC0415

        driver = source_type(self.name or "")
        return bool(driver is not None and driver.sends)

    @computed_field
    @property
    def load_error(self) -> str:
        """Why this folder's source did not load (no ``source.py``, an import error, a name a
        shipped source owns), or ``""``."""
        from flow_sdk.ingest.source_registry import load_error_for  # noqa: PLC0415

        return load_error_for(self.name or "")

    def coerce_config(self, config: dict) -> dict:
        """The row's field catalog applied to a source's ``config``."""
        return coerce_config(self.config or {}, config)
