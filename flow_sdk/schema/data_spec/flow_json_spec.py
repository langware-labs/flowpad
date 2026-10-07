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

Three source forms, one parser (:func:`parse_source`):

* ``git+<clone url>#<branch>`` — a repository; ``path`` descends into it.
* ``hub:<project id>`` — a hub project; its hosted repository is fetched.
* ``file:<path>`` — a folder with no git, on this machine only.

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

FLOW_JSON = "flow.json"
#: A dependency's name — the key in the file, the handle every verb takes.
DEPENDENCY_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$")
#: A project whose every prompt must carry a dozen skills has not chosen; it has listed.
MAX_ALWAYS_USE_SKILLS = 8

SourceKind = Literal["git", "hub", "file"]
DependencyStateName = Literal["ready", "missing", "unreachable", "not_installed", "invalid"]


def _clean_path(value: object) -> str:
    path = str(value or ".").strip().replace("\\", "/").rstrip("/") or "."
    return path.removeprefix("./") or "."


class DependencySource(DataSpec):
    """A parsed ``source`` string: WHAT the dependency is, without where it lives here."""

    spec_kind: ClassVar[str] = "flow.dependency.source"

    kind: SourceKind
    #: git: the clone URL · hub: the project id · file: the path as written (``~`` kept).
    target: str
    #: git only: the branch after ``#``; empty means the remote's default.
    branch: str = ""

    def render(self) -> str:
        if self.kind == "git":
            return f"git+{self.target}" + (f"#{self.branch}" if self.branch else "")
        return f"{self.kind}:{self.target}"


def parse_source(source: str) -> DependencySource:
    """``"git+…#branch" | "hub:<id>" | "file:<path>"`` → :class:`DependencySource`.

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
    raise ValueError(f"{raw!r}: a source starts with git+, hub: or file:")


def expand_file_target(target: str, *, base: Optional[Path] = None) -> Path:
    """A ``file:`` target as an absolute path on this machine: ``~`` expanded, a
    relative path taken from ``base`` (the project root that declared it)."""
    path = Path(target).expanduser()
    if not path.is_absolute() and base is not None:
        path = Path(base) / path
    return path


class DependencyTarget(DataSpec):
    """The object form of one entry: ``{"source": …, "path": …}``."""

    spec_kind: ClassVar[str] = "flow.dependency.target"

    source: str
    path: str = "."

    @field_validator("source")
    @classmethod
    def _parsable(cls, value: str) -> str:
        parse_source(value)
        return value.strip()

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

    name: str
    source: str
    path: str = "."
    required: bool = True

    @property
    def parsed(self) -> DependencySource:
        return parse_source(self.source)


class FlowJsonSpec(DataSpec):
    """``flow.json`` — the shape, every rule a validator. A value: the writer
    replaces the file wholesale with :meth:`to_document`."""

    spec_kind: ClassVar[str] = "flow.json"
    main_file: ClassVar[str | None] = FLOW_JSON

    model_config = ConfigDict(extra="forbid", frozen=True, populate_by_name=True)

    dependencies: dict[str, Union[str, DependencyTarget]] = Field(default_factory=dict)
    optional_dependencies: dict[str, Union[str, DependencyTarget]] = Field(
        default_factory=dict, alias="optionalDependencies"
    )
    autolaunch_journey: Optional[str] = Field(default=None, alias="autolaunchJourney")
    always_use_skills: list[str] = Field(default_factory=list, alias="alwaysUseSkills")

    @field_validator("dependencies", "optional_dependencies")
    @classmethod
    def _entries(cls, value: dict) -> dict:
        for name, entry in value.items():
            if not DEPENDENCY_NAME.match(name):
                raise ValueError(f"{name!r} is not a dependency name (letters, digits, . _ -)")
            if isinstance(entry, str):
                parse_source(entry)
        return value

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

    @model_validator(mode="after")
    def _one_name_one_entry(self) -> "FlowJsonSpec":
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
                source, path = (entry, ".") if isinstance(entry, str) else (entry.source, entry.path)
                out.append(FlowDependency(name=name, source=source.strip(), path=path, required=required))
        return out

    def find(self, name: str) -> Optional[FlowDependency]:
        return next((e for e in self.entries() if e.name == name), None)

    # ── writing (every helper returns a NEW value) ──────────────────────────

    def with_dependency(self, dep: FlowDependency) -> "FlowJsonSpec":
        """Add or replace ``dep`` by name; a re-declaration keeps its slot, and moving
        between required and optional moves it to the end of the other map."""
        value: Union[str, DependencyTarget] = (
            dep.source if dep.path == "." else DependencyTarget(source=dep.source, path=dep.path)
        )
        required = {k: v for k, v in self.dependencies.items() if dep.required or k != dep.name}
        optional = {k: v for k, v in self.optional_dependencies.items() if not dep.required or k != dep.name}
        (required if dep.required else optional)[dep.name] = value
        return self.model_copy(update={"dependencies": required, "optional_dependencies": optional})

    def without(self, name: str) -> "FlowJsonSpec":
        return self.model_copy(
            update={
                "dependencies": {k: v for k, v in self.dependencies.items() if k != name},
                "optional_dependencies": {k: v for k, v in self.optional_dependencies.items() if k != name},
            }
        )

    def to_document(self) -> dict:
        """The on-disk form: camelCase keys, empty sections left out, string entries
        where there is no ``path`` — what a person would have written."""
        def table(entries: dict) -> dict:
            return {
                k: (v if isinstance(v, str) else (v.source if v.path == "." else v.model_dump()))
                for k, v in entries.items()
            }

        document: dict = {}
        if self.dependencies:
            document["dependencies"] = table(self.dependencies)
        if self.optional_dependencies:
            document["optionalDependencies"] = table(self.optional_dependencies)
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
    #: A required, not-ready dependency whose warning was dismissed until the next restart.
    dismissed: bool = False


__all__ = [
    "DEPENDENCY_NAME",
    "FLOW_JSON",
    "DependencySource",
    "DependencyState",
    "DependencyTarget",
    "FlowDependency",
    "FlowJsonSpec",
    "expand_file_target",
    "parse_source",
]
