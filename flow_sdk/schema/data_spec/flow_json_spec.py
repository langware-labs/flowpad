"""``flow.json`` — what a project declares about itself, as a value.

One file at the project root, shaped after ``package.json``. It names the folders the
project expects in its context (``dependencies`` must be there, ``optionalDependencies``
may be), and two standing declarations every clone of the project must also see::

    {
      "dependencies": {
        "langware-os": "git+https://github.com/langware-labs/langware-os#main",
        "legal-docs":  {"source": "git+https://github.com/acme/handbook#main", "path": "legal"}
      },
      "optionalDependencies": {"policies": "hub:8c1f0b2e-…", "notes": "file:~/notes"},
      "autolaunchJourney": "engagement-setup",
      "alwaysUseSkills": ["triage-ticket"]
    }

A dependency is a CLAIM about context, never a capability: it says "this folder is
in my context", not "copy these assets" (that is ``deps.json``) and not "these are
my exports" (``project_manifest.json``). Resolving one is
``flow_sdk/builtin/project_dependencies.py``.

**Any folder asset may hold one too** (``<asset folder>/flow.json``, :class:`AssetFlowJsonSpec`):
the same two maps, and nothing else. A project's root file is that file at the top of the tree.
An asset names what it depends on BY ID only — a single-file asset never has dependencies::

    {
      "dependencies": {
        "team-kb":    "data_source-7c1e…",
        "company-kb": {"ref": "data_source-0a9d…", "name": "Company knowledge", "description": "…"}
      },
      "optionalDependencies": {"icp": "gtm.icp.id.5d20…"}
    }

Four source forms, one parser (:func:`parse_source`):

* ``<type>-<uuid>`` (a TypeId) or ``<kind>.id.<uuid>`` (a kind-id) — an asset or a value, by id:
  looked up on this machine, then on the hub, else ``not_found``. The only form an asset may use.
* ``git+<clone url>#<branch>`` — a repository; ``path`` descends into it. Project root only.
* ``hub:<project id>`` — a hub project; its hosted repository is fetched. Project root only.
* ``file:<path>`` — a folder with no git, on this machine only. Project root only.

This module is DB-free: a reader holding only the bytes can validate them.
"""

from __future__ import annotations

import re
from pathlib import Path
from typing import ClassVar, Literal, Optional, Union

from pydantic import ConfigDict, Field, field_validator, model_validator

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.origin.fs_origin import is_safe_rel_path
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.schema.data_spec.value_ref import parse_ref as parse_kind_id
from flow_sdk.tags.envelope import parse_target

FLOW_JSON = "flow.json"
#: A dependency's name — the key in the file, the handle every verb takes.
DEPENDENCY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
#: A project whose every prompt must carry a dozen skills has not chosen; it has listed.
MAX_ALWAYS_USE_SKILLS = 8

SourceKind = Literal["ref", "git", "hub", "file"]
#: ``not_found``: an id nothing on this machine or on the hub answers to.
DependencyStateName = Literal["ready", "missing", "unreachable", "not_installed", "invalid", "not_found"]
RefForm = Literal["", "typeid", "kind"]


def parse_id(ref: str) -> Optional[tuple[RefForm, str, str]]:
    """``(form, type_or_kind, id)`` for a TypeId (``form="typeid"``) or a kind-id (``form="kind"``),
    else None — each through its one grammar (``parse_target``, ``value_ref.parse_ref``). Syntax
    only: which asset type a kind names is the resolver's question."""
    raw = str(ref or "").strip()
    kind_id = parse_kind_id(raw)
    if kind_id is not None:
        return "kind", kind_id[0], kind_id[1].lower()
    type_name, entity_id = parse_target(raw)
    # ``parse_target`` also reads ``type:id`` and named ids; a dependency is the uuid form only.
    if type_name and entity_id and raw == f"{type_name}-{entity_id}" and is_valid_entity_id(entity_id):
        return "typeid", type_name, entity_id.lower()
    return None


def _clean_path(value: object) -> str:
    path = str(value or ".").strip().replace("\\", "/").rstrip("/") or "."
    return path.removeprefix("./") or "."


class DependencySource(DataSpec):
    """A parsed ``source`` string: WHAT the dependency is, without where it lives here."""

    spec_kind: ClassVar[str] = "flow.dependency.source"

    kind: SourceKind
    #: ref: the id as written · git: the clone URL · hub: the project id · file: the path as written (``~`` kept).
    target: str
    #: git only: the branch after ``#``; empty means the remote's default.
    branch: str = ""
    #: ref only: ``typeid`` or ``kind``, the type (or kind) it names, and the id.
    ref_form: RefForm = ""
    ref_type: str = ""
    ref_id: str = ""

    def render(self) -> str:
        if self.kind == "ref":
            return self.target
        if self.kind == "git":
            return f"git+{self.target}" + (f"#{self.branch}" if self.branch else "")
        return f"{self.kind}:{self.target}"


def parse_source(source: str) -> DependencySource:
    """``"<type>-<uuid>" | "<kind>.id.<uuid>" | "git+…#branch" | "hub:<id>" | "file:<path>"`` →
    :class:`DependencySource`.

    Raises ``ValueError`` naming the problem; the file validator turns that into one
    readable refusal per entry.
    """
    raw = str(source or "").strip()
    if raw.startswith("git+"):
        url, _, branch = raw[len("git+"):].partition("#")
        from flow_sdk.utils.git_identity import parse_git_origin_url  # noqa: PLC0415

        if not url or parse_git_origin_url(url) is None:
            raise ValueError(f"{raw!r}: not a recognizable git URL")
        return DependencySource(kind="git", target=url, branch=branch.strip())
    if raw.startswith("hub:"):
        project_id = raw[len("hub:"):].strip()
        if not is_valid_entity_id(project_id):
            raise ValueError(f"{raw!r}: a hub source names a project id (uuid)")
        return DependencySource(kind="hub", target=project_id)
    if raw.startswith("file:"):
        path = raw[len("file:"):].strip()
        if not path:
            raise ValueError(f"{raw!r}: a file source names a folder")
        return DependencySource(kind="file", target=path)
    parsed = parse_id(raw)
    if parsed is not None:
        form, type_name, entity_id = parsed
        return DependencySource(kind="ref", target=raw, ref_form=form, ref_type=type_name, ref_id=entity_id)
    raise ValueError(f"{raw!r}: a dependency is an id (<type>-<uuid> or <kind>.id.<uuid>), or starts with git+, hub: or file:")


def expand_file_target(target: str, *, base: Optional[Path] = None) -> Path:
    """A ``file:`` target as an absolute path on this machine: ``~`` expanded, a
    relative path taken from ``base`` (the project root that declared it)."""
    path = Path(target).expanduser()
    if not path.is_absolute() and base is not None:
        path = Path(base) / path
    return path


class DependencyTarget(DataSpec):
    """The object form of one entry: ``{"ref": …, "name": …, "description": …}`` for an id, or
    ``{"source": …, "path": …}`` for a location (project root only). ``name`` is the human-friendly
    name; the key it sits under stays the handle every verb takes."""

    spec_kind: ClassVar[str] = "flow.dependency.target"
    model_config = ConfigDict(populate_by_name=True)

    ref: str = ""
    source: str = ""
    path: str = "."
    label: Optional[str] = Field(default=None, alias="name")
    description: Optional[str] = None

    @field_validator("ref")
    @classmethod
    def _an_id(cls, value: str) -> str:
        value = value.strip()
        if value and parse_id(value) is None:
            raise ValueError(f"{value!r}: ref is an id (<type>-<uuid> or <kind>.id.<uuid>)")
        return value

    @field_validator("source")
    @classmethod
    def _parsable(cls, value: str) -> str:
        if value.strip():
            parse_source(value)
        return value.strip()

    @model_validator(mode="after")
    def _one_target(self) -> "DependencyTarget":
        if bool(self.ref) == bool(self.source):
            raise ValueError("an entry names exactly one of ref (an id) or source (a location)")
        if self.ref and self.path != ".":
            raise ValueError("path descends into a source; an id names its asset whole")
        return self

    @property
    def target(self) -> str:
        return self.ref or self.source

    @field_validator("path", mode="before")
    @classmethod
    def _inside(cls, value: object) -> str:
        path = _clean_path(value)
        if path != "." and not is_safe_rel_path(path):
            raise ValueError(f"path {path!r} must stay inside the source")
        return path


class FlowDependency(DataSpec):
    """One declared dependency, flattened: the name, where it comes from, whether it must be there."""

    spec_kind: ClassVar[str] = "flow.dependency"

    #: The key it is declared under — the handle every verb takes.
    name: str
    #: The id (``ref``) or the location (``git+``/``hub:``/``file:``) as written.
    source: str
    path: str = "."
    required: bool = True
    #: The human-friendly name and description an entry may carry.
    label: Optional[str] = None
    description: Optional[str] = None

    @property
    def parsed(self) -> DependencySource:
        return parse_source(self.source)

    @property
    def is_ref(self) -> bool:
        return self.parsed.kind == "ref"


class AssetFlowJsonSpec(DataSpec):
    """``<asset folder>/flow.json`` — what one asset depends on, by id. A value: the writer
    replaces the file wholesale with :meth:`to_document`."""

    spec_kind: ClassVar[str] = "asset.flow.json"
    main_file: ClassVar[str | None] = FLOW_JSON
    #: Whether an entry may name a location (``git+``/``hub:``/``file:``) — a project's root file only.
    locations: ClassVar[bool] = False

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    dependencies: dict[str, Union[str, DependencyTarget]] = Field(default_factory=dict)
    optional_dependencies: dict[str, Union[str, DependencyTarget]] = Field(
        default_factory=dict, alias="optionalDependencies"
    )

    @field_validator("dependencies", "optional_dependencies")
    @classmethod
    def _entries(cls, value: dict) -> dict:
        for name, entry in value.items():
            if not DEPENDENCY_NAME.match(name):
                raise ValueError(f"{name!r} is not a dependency name (letters, digits, . _ -)")
            target = entry if isinstance(entry, str) else entry.target
            if parse_source(target).kind != "ref" and not cls.locations:
                raise ValueError(f"{name!r}: an asset depends on an id (<type>-<uuid> or <kind>.id.<uuid>), not a location")
        return value

    @model_validator(mode="after")
    def _one_name_one_entry(self) -> "AssetFlowJsonSpec":
        both = set(self.dependencies) & set(self.optional_dependencies)
        if both:
            raise ValueError(f"{sorted(both)} declared both required and optional")
        return self

    # ── reading ─────────────────────────────────────────────────────────────

    def entries(self) -> list[FlowDependency]:
        """Every declared dependency, required first, each map in file order."""
        out: list[FlowDependency] = []
        for required, table in ((True, self.dependencies), (False, self.optional_dependencies)):
            for name, entry in table.items():
                if isinstance(entry, str):
                    out.append(FlowDependency(name=name, source=entry.strip(), required=required))
                else:
                    out.append(FlowDependency(
                        name=name, source=entry.target, path=entry.path, required=required,
                        label=entry.label, description=entry.description,
                    ))
        return out

    def find(self, name: str) -> Optional[FlowDependency]:
        return next((e for e in self.entries() if e.name == name), None)

    # ── writing (every helper returns a NEW value) ──────────────────────────

    def with_dependency(self, dep: FlowDependency):
        """Add or replace ``dep`` by name; a re-declaration keeps its slot, and moving
        between required and optional moves it to the end of the other map."""
        value: Union[str, DependencyTarget]
        if dep.label or dep.description:
            value = DependencyTarget(
                ref=dep.source if dep.is_ref else "", source="" if dep.is_ref else dep.source,
                path=dep.path, label=dep.label, description=dep.description,
            )
        elif dep.path != ".":
            value = DependencyTarget(source=dep.source, path=dep.path)
        else:
            value = dep.source
        required = {k: v for k, v in self.dependencies.items() if dep.required or k != dep.name}
        optional = {k: v for k, v in self.optional_dependencies.items() if not dep.required or k != dep.name}
        (required if dep.required else optional)[dep.name] = value
        return self.model_copy(update={"dependencies": required, "optional_dependencies": optional})

    def without(self, name: str):
        return self.model_copy(
            update={
                "dependencies": {k: v for k, v in self.dependencies.items() if k != name},
                "optional_dependencies": {k: v for k, v in self.optional_dependencies.items() if k != name},
            }
        )

    def to_document(self) -> dict:
        """The on-disk form: camelCase keys, empty sections left out, string entries
        where there is nothing but the target — what a person would have written."""
        def entry(v: Union[str, DependencyTarget]) -> Union[str, dict]:
            if isinstance(v, str):
                return v
            if v.path == "." and not v.label and not v.description:
                return v.target
            return v.model_dump(by_alias=True, exclude_defaults=True)

        document: dict = {}
        if self.dependencies:
            document["dependencies"] = {k: entry(v) for k, v in self.dependencies.items()}
        if self.optional_dependencies:
            document["optionalDependencies"] = {k: entry(v) for k, v in self.optional_dependencies.items()}
        return document


class FlowJsonSpec(AssetFlowJsonSpec):
    """``flow.json`` at a project's root — the asset file at the top of the tree, plus what only a
    project declares. Its entries may also name a location."""

    spec_kind: ClassVar[str] = "flow.json"
    locations: ClassVar[bool] = True

    autolaunch_journey: Optional[str] = Field(default=None, alias="autolaunchJourney")
    always_use_skills: list[str] = Field(default_factory=list, alias="alwaysUseSkills")

    @field_validator("autolaunch_journey", mode="before")
    @classmethod
    def _journey(cls, value: object) -> Optional[str]:
        return value.strip() if isinstance(value, str) and value.strip() else None

    @field_validator("always_use_skills", mode="before")
    @classmethod
    def _skills(cls, value: object) -> list[str]:
        if value is None:
            return []
        if not isinstance(value, list) or not all(isinstance(v, str) for v in value):
            raise ValueError("alwaysUseSkills is a list of skill names")
        out: list[str] = []
        for raw in value:
            name = raw.strip()
            if name and name not in out:
                out.append(name)
        if len(out) > MAX_ALWAYS_USE_SKILLS:
            raise ValueError(f"alwaysUseSkills holds at most {MAX_ALWAYS_USE_SKILLS} skills")
        return out

    def to_document(self) -> dict:
        document = super().to_document()
        if self.autolaunch_journey:
            document["autolaunchJourney"] = self.autolaunch_journey
        if self.always_use_skills:
            document["alwaysUseSkills"] = list(self.always_use_skills)
        return document


class DependencyState(DataSpec):
    """One dependency as it stands on THIS machine — what every verb answers."""

    spec_kind: ClassVar[str] = "flow.dependency.state"

    name: str
    source: str
    required: bool = True
    path: str = "."
    state: DependencyStateName
    #: The resolved local folder (``ready`` only).
    local_path: Optional[str] = None
    #: Why it is not ready, or a note on a ready one (a branch mismatch).
    reason: Optional[str] = None
    #: The dependency that declared it, for one reached transitively; ``None`` = this project.
    via: Optional[str] = None
    #: Every hop from the project to this one (``[]`` for one the project's own file declares): the
    #: names of the dependencies on the way, or the asset (``data_source/<name>``) that declared it.
    via_path: list[str] = Field(default_factory=list)
    #: The id the entry names resolved to (``<type>-<uuid>``), for an id dependency.
    typeid: Optional[str] = None
    label: Optional[str] = None
    description: Optional[str] = None
    #: A required, not-ready dependency whose warning was dismissed until the next restart.
    dismissed: bool = False


__all__ = [
    "DEPENDENCY_NAME",
    "FLOW_JSON",
    "AssetFlowJsonSpec",
    "parse_id",
    "DependencySource",
    "DependencyState",
    "DependencyTarget",
    "FlowDependency",
    "FlowJsonSpec",
    "expand_file_target",
    "parse_source",
]
