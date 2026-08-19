"""The data-source manifest — `data_source.json`, parsed and validated.

A source is a folder asset, and this is the file that describes it. Parsing is a
PURE function over the decoded JSON plus the folder's file names: no reads, no
registry lookups, no network. That is what lets every rule below be exercised in
a REPL and pinned by a short test — the validation is the interesting part, and
validation that needs a filesystem to test does not get tested.

**Declare the minimum, discover the rest.** The runtime is not a field: the
folder answers it. A `fetch.py` means the folder carries its own implementation;
a `FETCH.md` means an agent does; neither means a driver registered in the SDK
under the same name.

**Traits belong to whoever can be authoritative.** A builtin source's driver
class already declares `emits`, `channel` and the rest, and `sync_source` stamps
them onto the row on the first poll. A manifest that declares them too is a
second copy that will drift — so it is a load ERROR, not a warning. Silently
ignoring it would recreate the exact bug the frontend catalog documents: a value
that looks authoritative, is owned by nobody, and gets corrected later.
"""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Mapping, Optional

from flow_sdk._compat import StrEnum
from flow_sdk.ingest.reflect import ReflectMode

#: Manifest format version. A source published today must still load after the
#: format moves, so the version is required rather than inferred from shape.
CURRENT_SCHEMA = 1

#: Files whose presence decides the runtime. Names are fixed so the answer is
#: readable from a directory listing rather than from a field that can lie.
SCRIPT_FILE = "fetch.py"
AGENT_FILE = "FETCH.md"
MANIFEST_FILE = "data_source.json"


class Runtime(StrEnum):
    """Where a source's implementation lives. Derived, never declared."""

    #: A driver registered in flow_sdk under this manifest's name.
    BUILTIN = "builtin"
    #: An executable in the folder, spoken to over the module RPC contract.
    SCRIPT = "script"
    #: A subagent prompt in the folder; a worker does the fetching.
    AGENT = "agent"


class IdUniqueness(StrEnum):
    """Whether a provider's id is unique within a segment or across the source.

    The default is SEGMENT, and the asymmetry is the reason this exists at all:
    a wrong SOURCE **merges** two distinct records — a Slack `ts` repeats across
    channels — and a merge cannot be undone. A wrong SEGMENT only duplicates,
    and an enumerate-diff sweep reaps duplicates. The default is the
    lossy-but-recoverable side on purpose.
    """

    SEGMENT = "segment"
    SOURCE = "source"


class FieldType(StrEnum):
    """What a config field renders as, and how its raw string is typed.

    An enum rather than a bare string because `_config_from` already rejects an
    unknown KEY — accepting any `type` value meant a typo silently rendered a
    text input and stored a scalar where the driver expected a list, with no
    load error to point at it.
    """

    TEXT = "text"
    LINES = "lines"
    CSV = "csv"
    NUMBER = "number"
    PATH = "path"


class ManifestError(ValueError):
    """A manifest that cannot be loaded. The message is shown to an author."""


@dataclass(frozen=True)
class ConfigField:
    """One field of the user-facing form — the whole reason the frontend can
    stop hardcoding a catalog per provider."""

    type: FieldType = FieldType.TEXT
    required: bool = False
    label: str = ""
    hint: str = ""
    placeholder: str = ""
    default: Any = None
    advanced: bool = False
    pattern: str = ""
    #: Marks the field that names the remote account. Descriptive only — ids are
    #: uuid4 and nothing dedupes on it, so a wrong one is a plain edit. Absent
    #: on every field means the source has no account to name, which is Slack's
    #: case: the workspace belongs to the connection, not to this form.
    account_key: bool = False


@dataclass(frozen=True)
class Auth:
    """How the source is credentialed. Exactly one shape, never both.

    They are different resolvers, not a style choice: a connector reaches the
    credential store and refreshes mid-sync, while env names are resolved into a
    spawned process at launch. Neither ever carries a value.
    """

    connector: str = ""
    scopes: tuple[str, ...] = ()
    env: tuple[str, ...] = ()


@dataclass(frozen=True)
class Traits:
    """What only a non-builtin source has to declare about itself."""

    emits: str = ""
    channel: str = ""
    id_unique_within: IdUniqueness = IdUniqueness.SEGMENT
    owns_bytes: bool = True


@dataclass(frozen=True)
class Manifest:
    name: str
    title: str
    description: str = ""
    #: A lucide glyph name for THIS source in the provider picker.
    #: Deliberately not `icon`: `APIEntity.icon` is a getter returning the
    #: TYPE's registry glyph, which every spec shares. Declaring a field by
    #: that name shadows the getter and throws on hydration.
    icon_name: str = ""
    #: Wiki page explaining the setup step a provider cannot do for you.
    #: Only meaningful for a source whose driver has `verify`.
    setup_wiki: str = ""
    schema: int = CURRENT_SCHEMA
    requires: Mapping[str, str] = field(default_factory=dict)
    auth: Optional[Auth] = None
    reflect: tuple[str, ...] = (ReflectMode.RECORD.value,)
    config: Mapping[str, ConfigField] = field(default_factory=dict)
    traits: Optional[Traits] = None
    runtime: Runtime = Runtime.BUILTIN


def _auth_from(raw: Any) -> Optional[Auth]:
    if raw in (None, {}):
        return None
    if not isinstance(raw, dict):
        raise ManifestError("auth must be an object")
    connector = str(raw.get("connector") or "")
    env = tuple(str(v) for v in (raw.get("env") or ()))
    if connector and env:
        raise ManifestError("auth declares both connector and env; a source has one credential lifetime")
    if not connector and not env:
        raise ManifestError("auth must declare either connector or env")
    return Auth(connector=connector, scopes=tuple(str(s) for s in (raw.get("scopes") or ())), env=env)


def _reflect_from(raw: Any) -> tuple[str, ...]:
    if raw in (None, ()):
        return (ReflectMode.RECORD.value,)
    modes = tuple(str(m) for m in (raw if isinstance(raw, (list, tuple)) else [raw]))
    valid = {m.value for m in ReflectMode}
    for mode in modes:
        if mode not in valid:
            raise ManifestError(f"unknown reflect mode {mode!r}; expected one of {sorted(valid)}")
    # A source lands its payload in the graph as a record OR on disk as an
    # asset. Offering both in one picker lets a user ask for both and get
    # neither, which is the split `ReflectMode` exists to prevent.
    if len(modes) > 1 and ReflectMode.RECORD.value in modes:
        raise ManifestError("reflect cannot offer 'record' alongside filesystem modes")
    return modes


def _config_from(raw: Any) -> dict[str, ConfigField]:
    if raw in (None, {}):
        return {}
    if not isinstance(raw, dict):
        raise ManifestError("config must be an object")
    out: dict[str, ConfigField] = {}
    for key, spec in raw.items():
        if not isinstance(spec, dict):
            raise ManifestError(f"config.{key} must be an object")
        unknown = set(spec) - set(ConfigField.__dataclass_fields__)
        if unknown:
            raise ManifestError(f"config.{key} has unknown keys: {sorted(unknown)}")
        field_type = spec.get("type", FieldType.TEXT)
        try:
            spec = {**spec, "type": FieldType(field_type)}
        except ValueError as exc:
            raise ManifestError(
                f"config.{key}.type {field_type!r} is not one of "
                f"{[t.value for t in FieldType]}"
            ) from exc
        out[str(key)] = ConfigField(**spec)
    return out


def _traits_from(raw: Any) -> Optional[Traits]:
    if raw in (None, {}):
        return None
    if not isinstance(raw, dict):
        raise ManifestError("traits must be an object")
    unknown = set(raw) - {"emits", "channel", "id_unique_within", "owns_bytes"}
    if unknown:
        raise ManifestError(f"traits has unknown keys: {sorted(unknown)}")
    return Traits(
        emits=str(raw.get("emits") or ""),
        channel=str(raw.get("channel") or ""),
        id_unique_within=IdUniqueness(raw.get("id_unique_within") or IdUniqueness.SEGMENT.value),
        owns_bytes=bool(raw.get("owns_bytes", True)),
    )


def runtime_for(files: set[str]) -> Runtime:
    """Which runtime a folder's contents imply.

    Both markers present is an error rather than a precedence rule: there is no
    honest default, and picking one silently would run an implementation the
    author did not mean to ship.
    """
    has_script, has_agent = SCRIPT_FILE in files, AGENT_FILE in files
    if has_script and has_agent:
        raise ManifestError(f"folder has both {SCRIPT_FILE} and {AGENT_FILE}; keep one")
    if has_script:
        return Runtime.SCRIPT
    if has_agent:
        return Runtime.AGENT
    return Runtime.BUILTIN


def parse_manifest(data: Any, *, files: Optional[set[str]] = None) -> Manifest:
    """Decoded ``data_source.json`` plus the folder's file names -> a Manifest.

    Pure: no reads, no registry, no network. ``files`` is the directory listing,
    which is the only thing the runtime derivation needs.
    """
    if not isinstance(data, dict):
        raise ManifestError("manifest must be a JSON object")

    name = str(data.get("name") or "").strip()
    if not name:
        raise ManifestError("manifest has no name")

    schema = int(data.get("schema") or 0)
    if schema != CURRENT_SCHEMA:
        raise ManifestError(f"unsupported schema {schema}; this build reads {CURRENT_SCHEMA}")

    runtime = runtime_for(files or set())
    traits = _traits_from(data.get("traits"))

    # The driver class is authoritative for a builtin, and `sync_source` stamps
    # its kind and channel onto the row on the first poll. A manifest copy is a
    # second owner of the same fact.
    if traits is not None and runtime is Runtime.BUILTIN:
        raise ManifestError(
            "a builtin source must not declare traits; its driver class owns them"
        )

    return Manifest(
        name=name,
        title=str(data.get("title") or name),
        description=str(data.get("description") or ""),
        icon_name=str(data.get("icon_name") or ""),
        setup_wiki=str(data.get("setup_wiki") or ""),
        schema=schema,
        requires={str(k): str(v) for k, v in (data.get("requires") or {}).items()},
        auth=_auth_from(data.get("auth")),
        reflect=_reflect_from(data.get("reflect")),
        config=_config_from(data.get("config")),
        traits=traits,
        runtime=runtime,
    )
