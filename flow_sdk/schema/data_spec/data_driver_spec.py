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
    ``ingest_items`` path every record source takes. It lives in this enum
    because the choice is genuinely one axis: a source lands its payload in
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
    """Who implements the source. There is one runtime: the folder's own ``source.py``, one
    ``flow_sdk.sources.Source`` subclass, loaded in process by the source registry."""

    SOURCE = "source"


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


class FieldHints(DataSpec):
    """How the form draws one config field: its widget, words and placement. The field's RULES —
    required, pattern, default, type — are the driver's Config (DataDriver.config_schema);
    extra="forbid" refuses a catalog that still states them here."""

    model_config = ConfigDict(frozen=True)

    #: The widget: lines / csv a list typed one per line or comma, path a folder picker.
    type: FieldType = FieldType.TEXT
    label: str = ""
    hint: str = ""
    placeholder: str = ""
    advanced: bool = False
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
    def _choices_needs_a_pickable_type(self) -> "FieldHints":
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


class AuthSpec(DataSpec):
    """How the source is credentialed. Exactly one shape.

    They are different resolvers, not a style choice (``flow_sdk/ingest/credentials.py``): a
    connector reaches the connection store and refreshes mid-sync, env names are read from the
    operator's environment, and secrets name the values a row supplies — each optionally kept as a
    machine secret. None of them ever carries a value.
    """

    model_config = ConfigDict(frozen=True)

    connector: str = ""
    scopes: list[str] = Field(default_factory=list)
    env: list[str] = Field(default_factory=list)
    #: ``{value key: machine secret name}`` — ``""`` when only the row supplies it.
    secrets: dict[str, str] = Field(default_factory=dict)
    #: A SecretPack NAME, declared in the owner's project or the user scope — its values come
    #: from that scope's ``.env.local`` or vault, exactly as a worker process reads them.
    credential: str = ""
    #: ``{value key: env var of that credential}`` — required with ``credential``.
    vars: dict[str, str] = Field(default_factory=dict)

    @model_validator(mode="after")
    def _one_shape(self) -> "AuthSpec":
        present = (("connector", self.connector), ("env", self.env), ("secrets", self.secrets), ("credential", self.credential))
        shapes = [name for name, value in present if value]
        if len(shapes) > 1:
            raise ValueError(f"auth declares {' and '.join(shapes)}; a source has one credential lifetime")
        if not shapes:
            raise ValueError("auth must declare one of connector, env, secrets or credential")
        if bool(self.credential) != bool(self.vars):
            raise ValueError("auth `credential` and `vars` go together: which credential, and which of its variables")
        return self


class DataDriverSpec(DataSpec):
    """``data_driver.json`` — the shape, with every authoring rule as a validator."""

    model_config = ConfigDict(populate_by_name=True)   # extra="forbid" is DataSpec's

    #: The registry key AND the folder name. One noun: `rss` resolves the folder's own source class.
    name: str
    title: str = ""
    description: str = ""
    #: The record kind a source row carries (``datasource.api.slack``); ``datasource.<name>`` when omitted.
    kind: str = ""
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
    #: meaningful for a source whose class is `Verifiable`.
    setup_wiki: str = ""
    #: Manifest format version — the file says `schema`; the row says
    #: `manifest_schema` because the base Entity already owns `schema_version`.
    manifest_schema: int = Field(default=0, alias="schema", validate_default=True)
    #: Minimum host the source's code needs. Recorded, not yet enforced.
    requires: dict[str, str] = Field(default_factory=dict)
    #: `{connector, scopes}`, `{env: [...]}` or `{secrets: {...}}`. Never a value.
    auth: Optional[AuthSpec] = None
    #: Supported reflect modes, head first as the default. A list because the
    #: picker must not offer a mode that silently fails.
    reflect: list[str] = Field(default_factory=lambda: ["record"])
    #: The user-facing form. Replaces the frontend's hardcoded provider catalog.
    config: dict[str, FieldHints] = Field(default_factory=dict)
    #: Offered in the add-source picker. ``False`` keeps a provider loadable — its rows
    #: still poll, scripts still name it — without offering it to a person. A vendor
    #: reached through the cloud (AgentMail behind Agent Email) is unlisted.
    listed: bool = True
    #: The cloud creates the account for the owning agent: there is nothing to paste
    #: and no form, so the picker asks the cloud instead of saving a draft.
    provisioned: bool = False

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
        """The runtime the folder's contents imply. Pure: no reads, no registry, no network.

        The retired authored runtimes are refused where the author can read why, rather than
        indexing a definition nothing can run.
        """
        retired = sorted(files & set(RETIRED_RUNTIME_FILES))
        if retired:
            raise ManifestError(f"{' and '.join(retired)} belong to a retired runtime — {RETIRED_RUNTIME_UPGRADE}")
        return Runtime.SOURCE


SOURCE_FILE = "source.py"
SCRIPT_FILE = "fetch.py"
AGENT_FILE = "FETCH.md"
#: The authored runtimes a folder may still carry. No migration converts one: it is code to port.
RETIRED_RUNTIME_FILES = (SCRIPT_FILE, AGENT_FILE)
RETIRED_RUNTIME_UPGRADE = (
    "upgrade: write source.py, one flow_sdk.sources.Source subclass whose provider is this manifest's name "
    "(docs/data-management/data-source-asset.md, 'Porting a retired runtime')"
)
