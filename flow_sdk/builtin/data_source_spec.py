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

from typing import Any, ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField, Persist, Sharing
from flow_sdk.core import Entity
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.types import EntityType

#: The manifest format this build reads. A manifest that says otherwise is a
#: load error, not a best-effort parse.
CURRENT_SCHEMA = 1


class Runtime(StrEnum):
    """Who implements the source. DERIVED from the folder's contents, never
    declared, so it cannot disagree with what is actually there."""

    BUILTIN = "builtin"
    SCRIPT = "script"
    AGENT = "agent"


class FieldType(StrEnum):
    """What a config field renders as. The ts mirror (``data-source-spec.ts``)
    compares against these values."""

    TEXT = "text"
    LINES = "lines"
    CSV = "csv"
    NUMBER = "number"
    PATH = "path"


class ManifestError(ValueError):
    """A manifest folder that cannot be loaded. The message is shown to an author."""


class ConfigFieldSpec(DataSpec):
    """One field of the user-facing form — the whole reason the frontend can
    stop hardcoding a catalog per provider."""

    type: FieldType = FieldType.TEXT
    required: bool = False
    label: str = ""
    hint: str = ""
    placeholder: str = ""
    default: Any = None
    advanced: bool = False
    #: Regex the value must match — replaces the per-provider validators.
    pattern: str = ""
    #: Marks the field that names the remote account. Descriptive only — ids are
    #: uuid4 and nothing dedupes on it, so a wrong one is a plain edit. Absent
    #: on every field means the source has no account to name, which is Slack's
    #: case: the workspace belongs to the connection, not to this form.
    account_key: bool = False

    def coerce(self, value: Any) -> Any:
        """A value as a person (or an agent) typed it → the shape this field
        declares: ``lines``/``csv`` are lists, ``number`` a number. The one
        definition of what a ``FieldType`` means for a stored value."""
        if self.type in (FieldType.LINES, FieldType.CSV) and isinstance(value, str):
            sep = "\n" if self.type == FieldType.LINES else ","
            return [part.strip() for part in value.split(sep) if part.strip()]
        if self.type == FieldType.NUMBER and isinstance(value, str) and value.strip():
            try:
                number = float(value)
            except ValueError:
                return value
            return int(number) if number.is_integer() else number
        return value



class AuthSpec(DataSpec):
    """How the source is credentialed. Exactly one shape, never both.

    They are different resolvers, not a style choice: a connector reaches the
    credential store and refreshes mid-sync, while env names are resolved into a
    spawned process at launch. Neither ever carries a value.
    """

    connector: str = ""
    scopes: list[str] = Field(default_factory=list)
    env: list[str] = Field(default_factory=list)

    @model_validator(mode="after")
    def _one_shape(self) -> "AuthSpec":
        if self.connector and self.env:
            raise ValueError("auth declares both connector and env; a source has one credential lifetime")
        if not self.connector and not self.env:
            raise ValueError("auth must declare either connector or env")
        return self


class TraitsSpec(DataSpec):
    """What only a non-builtin source has to declare about itself.

    ``id_unique_within`` is deliberately NOT a field: the natural key is always
    ``(data_source_id, segment_key, external_id)``, so declaring it would promise
    a behaviour nothing implements — ``extra="forbid"`` makes it a load error
    until something reads it.
    """

    emits: str = ""
    channel: str = ""
    owns_bytes: bool = True



def coerce_config(fields: dict, config: dict) -> dict:
    """``config`` shaped by a field catalog (``{name: ConfigFieldSpec}``); unknown keys kept as-is."""
    return {k: (fields[k].coerce(v) if k in fields else v) for k, v in config.items()}


class ManifestSpec(DataSpec):
    """``data_source.json`` — the shape, with every authoring rule as a validator."""

    model_config = ConfigDict(populate_by_name=True)   # extra="forbid" is DataSpec's

    #: The registry key AND the folder name. One noun: `rss` resolves RssDriver.
    name: str
    title: str = ""
    description: str = ""
    #: A lucide glyph name for THIS source in the provider picker. Deliberately
    #: not `icon`: `APIEntity.icon` is a getter returning the TYPE's registry
    #: glyph, which every spec shares; a field by that name shadows the getter
    #: and throws on hydration.
    icon_name: str = ""
    #: Wiki page explaining the setup step a provider cannot do for you. Only
    #: meaningful for a source whose driver has `verify`.
    setup_wiki: str = ""
    #: Manifest format version — the file says `schema`; the row says
    #: `manifest_schema` because the base Entity already owns `schema_version`.
    manifest_schema: int = Field(default=0, alias="schema", validate_default=True)
    #: Minimum host for a spec that leans on a builtin driver. Without it,
    #: installing one on an older build fails as `unknown_provider`, which reads
    #: as a broken source rather than an old host.
    requires: dict[str, str] = Field(default_factory=dict)
    #: `{connector, scopes}` or `{env: [...]}`. Never a value.
    auth: Optional[AuthSpec] = None
    #: Supported reflect modes, head first as the default. A list because the
    #: picker must not offer a mode that silently fails.
    reflect: list[str] = Field(default_factory=lambda: ["record"])
    #: The user-facing form. Replaces the frontend's hardcoded provider catalog.
    config: dict[str, ConfigFieldSpec] = Field(default_factory=dict)
    #: Only non-builtin sources declare these; a builtin's driver class owns them.
    traits: Optional[TraitsSpec] = None

    @field_validator("name")
    @classmethod
    def _named(cls, value: str) -> str:
        value = str(value or "").strip()
        if not value:
            raise ValueError("manifest has no name")
        return value

    @field_validator("manifest_schema")
    @classmethod
    def _current_schema(cls, value: int) -> int:
        if value != CURRENT_SCHEMA:
            raise ValueError(f"unsupported schema {value}; this build reads {CURRENT_SCHEMA}")
        return value

    @field_validator("reflect", mode="before")
    @classmethod
    def _reflect_modes(cls, raw: Any) -> list[str]:
        from flow_sdk.ingest.reflect import ReflectMode  # noqa: PLC0415

        if raw in (None, (), []):
            return [ReflectMode.RECORD.value]
        modes = [str(m) for m in (raw if isinstance(raw, (list, tuple)) else [raw])]
        valid = {m.value for m in ReflectMode}
        for mode in modes:
            if mode not in valid:
                raise ValueError(f"unknown reflect mode {mode!r}; expected one of {sorted(valid)}")
        # A source lands its payload in the graph as a record OR on disk as an
        # asset. Offering both in one picker lets a user ask for both and get
        # neither, which is the split `ReflectMode` exists to prevent.
        if len(modes) > 1 and ReflectMode.RECORD.value in modes:
            raise ValueError("reflect cannot offer 'record' alongside filesystem modes")
        return modes

    @model_validator(mode="after")
    def _title_defaults_to_name(self) -> "ManifestSpec":
        if not self.title:
            self.title = self.name
        return self

    def runtime_for_folder(self, files: set[str]) -> Runtime:
        """The runtime the folder's contents imply, with the two rules that need
        both the JSON and the listing. Pure: no reads, no registry, no network.

        Both markers present is an error rather than a precedence rule: there is
        no honest default, and picking one silently would run an implementation
        the author did not mean to ship.
        """
        has_script, has_agent = DataSourceSpec.SCRIPT_FILE in files, DataSourceSpec.AGENT_FILE in files
        if has_script and has_agent:
            raise ManifestError(f"folder has both {DataSourceSpec.SCRIPT_FILE} and {DataSourceSpec.AGENT_FILE}; keep one")
        runtime = Runtime.SCRIPT if has_script else Runtime.AGENT if has_agent else Runtime.BUILTIN
        if runtime is Runtime.AGENT:
            # Derived, storable, and dispatched by nothing: `driver_for_spec`
            # builds an adapter for SCRIPT only. A folder with FETCH.md would
            # index as a valid spec and then fail every poll with
            # `unknown_provider`. Reserved, not supported — say so where the
            # author can read it.
            raise ManifestError(
                f"{DataSourceSpec.AGENT_FILE} (agent runtime) is reserved but not implemented — "
                f"use {DataSourceSpec.SCRIPT_FILE} instead"
            )
        # The driver class is authoritative for a builtin, and `sync_source`
        # stamps its kind and channel onto the row on the first poll. A manifest
        # copy is a second owner of the same fact.
        if self.traits is not None and runtime is Runtime.BUILTIN:
            raise ManifestError("a builtin source must not declare traits; its driver class owns them")
        return runtime


class DataSourceSpec(Entity):
    """The ROW; its shape on disk is ``ManifestSpec`` (``TypeInfo.asset_spec``)."""

    #: Folder markers. Runtime is DERIVED from these, never declared. The
    #: manifest itself is ``TypeInfo.main_file`` (``data_source.json``).
    SCRIPT_FILE: ClassVar[str] = "fetch.py"
    AGENT_FILE: ClassVar[str] = "FETCH.md"

    type: str = APIField(default=EntityType.DATA_SOURCE_SPEC.value)

    # A folder-backed asset, so it OWNS its path — declaring `asset_ref` is what
    # enrolls the class in `Entity.asset_owner_classes()`, and therefore what
    # lets `get_by_asset_ref` resolve a folder to this row. PRIVATE: the path is
    # this machine's, and means nothing to a receiver.
    asset_ref: Optional[str] = APIField(None, sharing=Sharing.PRIVATE)

    # ── the header, held as entity fields ──
    title: str = APIField(default="")
    description: str = APIField(default="")
    icon_name: str = APIField(default="")
    setup_wiki: str = APIField(default="")
    manifest_schema: int = APIField(default=CURRENT_SCHEMA)
    requires: dict[str, str] = APIField(default_factory=dict)
    auth: Optional[AuthSpec] = APIField(default=None)
    reflect: list[str] = APIField(default_factory=list)
    config: dict[str, ConfigFieldSpec] = APIField(default_factory=dict)
    traits: Optional[TraitsSpec] = APIField(default=None)

    #: builtin | script | agent — DERIVED from the folder's contents by the
    #: extractor (``ManifestSpec.runtime_for_folder``), never authored; mirrored to the shadow
    #: so the driver registry can query it.
    runtime: str = APIField(default="builtin", persist=Persist.TRUE)

    _api_visible: ClassVar[bool] = True

    def coerce_config(self, config: dict) -> dict:
        """The row's field catalog applied to a source's ``config``."""
        return coerce_config(self.config or {}, config)
