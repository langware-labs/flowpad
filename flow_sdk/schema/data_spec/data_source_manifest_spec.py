"""Filesystem contracts independent of application entities."""
from __future__ import annotations

from typing import Any, Optional

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

CURRENT_SCHEMA = 1




class ReflectMode(StrEnum):
    """How a source's payload becomes locally present.

    ``RECORD`` is the default and is NOT a filesystem mode — it is the existing
    ``ingest_items`` path every shipped driver already takes. It lives in this
    enum because the choice is genuinely one axis: a source lands its payload in
    the graph as a record, or on disk as an asset. Splitting it across two
    settings would let a source ask for both and get neither.
    """

    #: The graph. `ingest_items` → SourceItem. Today's behaviour for rss,
    #: hackernews, slack, agent, agentmail, cloud_email.
    RECORD = "record"
    #: The source's own directory is the walk root; nothing is duplicated.
    #: The mount-not-copy case.
    NONE = "none"
    #: Bytes duplicated into the project.
    COPY = "copy"
    #: Linked into the project instead of duplicated. NOTE: `gitignore_walk`
    #: never follows symlinked DIRECTORIES, so this cannot work for a
    #: folder-layout asset — only for a file-layout one.
    SYMLINK = "symlink"


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

    model_config = ConfigDict(frozen=True)

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
    #: The provider can enumerate this field's legal values, so the form offers a
    #: list instead of asking for an id nobody can produce from memory (a shared
    #: drive is `0AB1cdEfGhIjKlMnOpQ`). Deliberately a FLAG, not a `FieldType`:
    #: `type` already decides the widget's shape — `text` picks one, `lines` picks
    #: many — and a `select` member would fork that axis in two, leaving every
    #: call site that switches on `type` to answer "one or many?" a second way.
    choices: bool = False

    @model_validator(mode="after")
    def _choices_needs_a_pickable_type(self) -> "ConfigFieldSpec":
        """A choosable field must be one `type` already knows how to render.

        The pairing IS the design: without it, `choices` on a `number` would reach the
        form as a picker with no widget to draw, which is the same shape of bug as a
        picker offering a reflect mode that cannot work.
        """
        if self.choices and self.type not in (FieldType.TEXT, FieldType.LINES):
            raise ValueError(
                f"choices is only legal on {FieldType.TEXT.value}/{FieldType.LINES.value} "
                f"fields — {self.type.value} has no picker shape"
            )
        return self

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

    model_config = ConfigDict(frozen=True)

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

    model_config = ConfigDict(frozen=True)

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
    #: Per-CHANNEL glyph names, for a spec that serves several channels through
    #: one transport (the agent spec reaches gmail AND slack). The inbox chip
    #: resolves `origin.kind` → the channel-named spec's `icon_name` first, then
    #: this map on the transport's spec — so a channel's icon stays an asset
    #: fact, never a frontend map.
    channel_icon_names: dict[str, str] = Field(default_factory=dict)
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

    @model_validator(mode="before")
    @classmethod
    def _title_defaults_to_name(cls, data: Any) -> Any:
        """A manifest that omits ``title`` is titled by its name.

        Filled BEFORE construction rather than assigned after it: a ``DataSpec`` is
        frozen, so an after-validator cannot write to the instance it was handed.
        """
        if isinstance(data, dict) and not data.get("title"):
            name = str(data.get("name") or "").strip()
            if name:
                return {**data, "title": name}
        return data

    def runtime_for_folder(self, files: set[str]) -> Runtime:
        """The runtime the folder's contents imply, with the two rules that need
        both the JSON and the listing. Pure: no reads, no registry, no network.

        Both markers present is an error rather than a precedence rule: there is
        no honest default, and picking one silently would run an implementation
        the author did not mean to ship.
        """
        has_script, has_agent = SCRIPT_FILE in files, AGENT_FILE in files
        if has_script and has_agent:
            raise ManifestError(f"folder has both {SCRIPT_FILE} and {AGENT_FILE}; keep one")
        runtime = Runtime.SCRIPT if has_script else Runtime.AGENT if has_agent else Runtime.BUILTIN
        if runtime is Runtime.AGENT:
            # Derived, storable, and dispatched by nothing: `driver_for_spec`
            # builds an adapter for SCRIPT only. A folder with FETCH.md would
            # index as a valid spec and then fail every poll with
            # `unknown_provider`. Reserved, not supported — say so where the
            # author can read it.
            raise ManifestError(
                f"{AGENT_FILE} (agent runtime) is reserved but not implemented — "
                f"use {SCRIPT_FILE} instead"
            )
        # The driver class is authoritative for a builtin, and `sync_source`
        # stamps its kind and channel onto the row on the first poll. A manifest
        # copy is a second owner of the same fact.
        if self.traits is not None and runtime is Runtime.BUILTIN:
            raise ManifestError("a builtin source must not declare traits; its driver class owns them")
        # A script source has no class to hold its kind, so the manifest is the
        # ONLY owner of `emits` — and `ingest_items` stamps it on every record
        # unvalidated. Left blank it produced items with an empty kind that
        # silently fell outside the inbox projection; a load error is the one
        # place the author can see it.
        if runtime is Runtime.SCRIPT and (self.traits is None or not self.traits.emits.strip()):
            raise ManifestError(
                "an authored source must declare traits.emits — the ontology kind stamped on every record"
            )
        return runtime



SCRIPT_FILE = "fetch.py"
AGENT_FILE = "FETCH.md"
