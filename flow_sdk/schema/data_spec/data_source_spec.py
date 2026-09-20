"""``data_source.json`` — the authored shape of a configured data source.

A ``DataSource`` is an instance of a ``DataDriver`` with a config, and it is an ASSET: an entity
document at ``<scope>/agentic-assets/data_source/<name>/data_source.json``. This class is that file —
what a person (or ``driver.create_source``) authors, and nothing the engine writes while it runs.
Status, health, cursors, the next poll, the identities a sync discovers: those live on the row only,
so a poll never rewrites the file and a git-shared project never commits a heartbeat.

The file key names the thing it points at (``data_driver_name``, ``data_driver_config``); the row keeps
its engine names (``provider``, ``config``). Aliases carry the file keys, the way ``DataDriverSpec``
carries ``schema`` for ``manifest_schema``.

Value-free by construction, like ``secret_pack.json``: a secret never lands in a folder a project
shares through git. A secret is a credential the driver declares, resolved through the bound store.
"""
from __future__ import annotations

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field, model_validator

from flow_sdk.schema.data_spec.credential_contract import assert_value_free
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.secrets.store import SecretStoreRef


class DataSourceSpec(AssetDocumentSpec):
    """``data_source.json``: which driver, with which config, owned by whom, polled how often."""

    main_file: ClassVar[str | None] = "data_source.json"
    manifest_layout: ClassVar[str | None] = "entity"

    model_config = ConfigDict(extra="ignore", populate_by_name=True)

    name: str = ""
    #: The ``DataDriver`` this source runs — its registry name.
    provider: str = Field(default="", alias="data_driver_name")
    #: The driver's config for this instance. Value-free.
    config: dict[str, Any] = Field(default_factory=dict, alias="data_driver_config")
    #: Whose source: the local user or an Agent (a TypeId string). Absent = the local user.
    owner: Optional[str] = None
    reflect: Optional[str] = None
    reflect_into: Optional[str] = None
    poll_interval_seconds: Optional[int] = None
    window_days: Optional[int] = None
    required_capabilities: Optional[list[str]] = None
    #: The store the driver's names load from (``{type, config}``); absent = the default store.
    secret_store: Optional[SecretStoreRef] = None
    #: The provider of the account this source acts as; absent = the driver's connector.
    connection: Optional[str] = None

    @model_validator(mode="before")
    @classmethod
    def _authored_source(cls, data: Any) -> Any:
        if not isinstance(data, dict):
            return data
        assert_value_free(data, where="data source")
        if not (data.get("data_driver_name") or data.get("provider")):
            raise ValueError(
                "not a data source document: it names no data_driver_name. A data source DRIVER "
                "(data_source.json from before 0.2.170) belongs in agentic-assets/data_driver/<name>/data_driver.json"
            )
        return data


__all__ = ["DataSourceSpec"]
