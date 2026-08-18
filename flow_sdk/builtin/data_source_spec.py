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
"""
from __future__ import annotations

from typing import Any, ClassVar, Optional

from flow_sdk.api.api_types.api_field import APIField, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class DataSourceSpec(Entity):
    type: str = APIField(default=EntityType.DATA_SOURCE_SPEC.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's, and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    #: The registry key AND the folder name. One noun: `rss` resolves RssDriver.
    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    #: Wiki page for the setup step, when the source has one.
    setup_wiki: str = APIField(default="")

    #: Manifest format version, so a source published today still loads after
    #: the format moves. NOT `schema_version` — the base Entity already owns that
    #: name as a string, and the collision fails validation at index time.
    manifest_schema: int = APIField(default=1)
    #: Minimum host for a spec that leans on a builtin driver. Without it,
    #: installing one on an older build fails as `unknown_provider`, which reads
    #: as a broken source rather than an old host.
    requires: dict = APIField(default_factory=dict)

    #: builtin | script | agent — DERIVED from the folder's contents, never
    #: authored, so it cannot disagree with what is actually there.
    runtime: str = APIField(default="builtin")

    #: Supported reflect modes, head first as the default. A list because the
    #: picker must not offer a mode that silently fails.
    reflect: list[str] = APIField(default_factory=list)

    #: The user-facing form. Replaces the frontend's hardcoded provider catalog.
    config_schema: dict = APIField(default_factory=dict)
    #: `{connector, scopes}` or `{env: [...]}`. Never a value.
    auth: Optional[dict] = APIField(default=None)
    #: Only non-builtin sources declare these; a builtin's driver class owns them.
    traits: Optional[dict] = APIField(default=None)

    _api_visible: ClassVar[bool] = True
