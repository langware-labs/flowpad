"""The project manifest — what a project has **published**, as a value.

An asset *publishes*: it declares, to whoever has access to the project, that
it is in the box and meant to be used. The manifest is the ledger of those
declarations. It lives in the repo (``agentic-assets/project_manifest/
project_manifest.json``) so it travels with a clone, and it is the source of
truth: the ``published`` flag on an entity row is a cache reconciled from it.

Publishing grants nothing. A row is information — *what* (a TypeId) and *where
inside this project* (``rel_path``) — never a capability. Access is the
project's roster; reaching the bytes is the origin's business.

This module is deliberately DB-free (pydantic + two pure validators) so a
DB-less reader — the hub serving the page from the git tree it already holds —
can import it against a pinned release. Anything that touches an entity row
lives in ``flow_sdk.builtin.project_manifest``.

**Why a TypeId is enough.** A publish first makes sure the asset carries its id
in its own carrier (frontmatter ``id:`` or the ``.flow/capsules`` sidecar), so
the id in a row is the same id every clone adopts. That is what makes the row
portable; without the stamp it would name a fact only the author's DB knows.
"""

from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import ConfigDict, Field, field_validator

from flow_sdk.api.api_types.identifier import is_valid_entity_id
from flow_sdk.fs_store.origin.field import OriginField
from flow_sdk.fs_store.origin.fs_origin import is_safe_rel_path
from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.tags.envelope import parse_target

#: The one schema this build reads. Bump only with a migration.
PROJECT_MANIFEST_SCHEMA = 1
#: The manifest's main document inside its folder.
PROJECT_MANIFEST_MAIN = "project_manifest.json"
#: The dependencies ledger beside it — what this project INSTALLED from others.
DEPS_MAIN = "deps.json"
#: The types a row may name in phase 1: every file-backed type whose carrier can
#: hold an id. ``spec`` is row-only (no carrier, no rel_path) and stays out.
PUBLISHABLE_TYPES: tuple[str, ...] = ("skill", "subagent", "markdown", "mcp")


def split_typeid(typeid: str) -> tuple[str, str]:
    """``"<type>-<uuid>"`` → ``(type, uuid)`` through the one wire-form parser
    (``parse_target``); a type name may itself contain ``-``."""
    type_name, entity_id = parse_target(typeid)
    if not type_name or not entity_id:
        raise ValueError(f"malformed typeid {typeid!r}")
    return type_name, entity_id


class PublishedAssetSpec(DataSpec):
    """One published asset. Keyed by ``typeid``; ``rel_path`` is where its
    carrier sits inside the project — the asset ROOT (the folder for a skill or
    an mcp, the file for a subagent or a document)."""

    spec_kind: ClassVar[str] = "project.manifest.entry"

    typeid: str
    rel_path: str
    #: Denormalized so a reader with no entity cache (the hub) can still list.
    name: str = ""
    description: str = ""
    #: ISO-8601 UTC, stamped by the writer.
    published_at: str = ""
    #: WHERE a reader can fetch the bytes — the publisher's git repo (a
    #: ``GitOrigin``: repo, branch, commit, ``rel_path``) or, when the repo has
    #: no remote, the asset's ``LocalOrigin`` (same machine only). A typeid
    #: says WHAT; this says WHERE. A malformed value reads as absent.
    origin: OriginField = None

    @field_validator("typeid")
    @classmethod
    def _publishable_typeid(cls, value: str) -> str:
        value = str(value or "").strip()
        type_name, entity_id = split_typeid(value)
        if type_name not in PUBLISHABLE_TYPES:
            raise ValueError(f"{type_name!r} cannot be published; expected one of {list(PUBLISHABLE_TYPES)}")
        if not is_valid_entity_id(entity_id):
            raise ValueError(f"{entity_id!r} is not an entity id (uuid v4/v5)")
        return value

    @field_validator("rel_path")
    @classmethod
    def _inside_the_project(cls, value: str) -> str:
        """Sender-controlled and joined onto a reader's root: refuse anything
        that could escape (absolute, ``..``, a drive letter, empty)."""
        value = str(value or "").strip().replace("\\", "/").rstrip("/")
        if not is_safe_rel_path(value):
            raise ValueError(f"rel_path {value!r} must be a relative path inside the project")
        return value

    @property
    def type(self) -> str:
        return split_typeid(self.typeid)[0]

    @property
    def id(self) -> str:
        return split_typeid(self.typeid)[1]


class ProjectManifestSpec(DataSpec):
    """``project_manifest.json`` — the shape, with every rule as a validator.

    Every helper returns a NEW instance: a spec is a value, and the writer
    replaces the file wholesale.
    """

    spec_kind: ClassVar[str] = "project.manifest"

    model_config = ConfigDict(populate_by_name=True)   # extra="forbid" is DataSpec's

    #: The file says ``schema``; the row says ``manifest_schema`` because the
    #: base Entity already owns ``schema_version``.
    manifest_schema: int = Field(default=PROJECT_MANIFEST_SCHEMA, alias="schema", validate_default=True)
    #: Minimum host, informational (``{"flowpad": ">=0.3"}``): lets a reader say
    #: "written by a newer build" rather than fail on an unknown key.
    requires: dict[str, str] = Field(default_factory=dict)
    entries: list[PublishedAssetSpec] = Field(default_factory=list)

    @field_validator("manifest_schema")
    @classmethod
    def _current_schema(cls, value: int) -> int:
        if value != PROJECT_MANIFEST_SCHEMA:
            raise ValueError(f"unsupported schema {value}; this build reads {PROJECT_MANIFEST_SCHEMA}")
        return value

    @field_validator("entries")
    @classmethod
    def _unique(cls, entries: list[PublishedAssetSpec]) -> list[PublishedAssetSpec]:
        seen_ids: set[str] = set()
        seen_paths: set[str] = set()
        for entry in entries:
            if entry.typeid in seen_ids:
                raise ValueError(f"duplicate entry for {entry.typeid}")
            if entry.rel_path in seen_paths:
                raise ValueError(f"two entries share rel_path {entry.rel_path!r}")
            seen_ids.add(entry.typeid)
            seen_paths.add(entry.rel_path)
        return entries

    # ── pure helpers ────────────────────────────────────────────────────────

    @classmethod
    def empty(cls):
        return cls()

    @property
    def typeids(self) -> frozenset[str]:
        return frozenset(e.typeid for e in self.entries)

    def find(self, typeid: str) -> Optional[PublishedAssetSpec]:
        return next((e for e in self.entries if e.typeid == typeid), None)

    def with_entry(self, entry):
        """Replace the row with this typeid in place, or append. Order is the
        publish order, and a re-publish keeps its slot."""
        entries = [entry if e.typeid == entry.typeid else e for e in self.entries]
        if all(e.typeid != entry.typeid for e in self.entries):
            entries.append(entry)
        return self.model_validate({**self.to_document(), "entries": [e.model_dump() for e in entries]})

    def without(self, typeid: str):
        return self.model_validate(
            {**self.to_document(), "entries": [e.model_dump() for e in self.entries if e.typeid != typeid]}
        )

    def to_document(self) -> dict:
        """The on-disk form: ``by_alias`` so the file says ``schema``."""
        return self.model_dump(by_alias=True)


class DependencySpec(PublishedAssetSpec):
    """One INSTALLED asset: the published row it came from, plus provenance.
    ``rel_path``/``origin`` describe the SOURCE; the local placement is derived
    by the type at install time and never recorded, so a re-placement cannot
    drift the ledger."""

    #: Redeclared on purpose — ``spec_kind`` is an inherited ClassVar and the
    #: registry is last-writer-wins; without this the subclass would silently
    #: take over ``project.manifest.entry``.
    spec_kind: ClassVar[str] = "project.dependency"

    source_project_id: str = ""
    source_project_name: str = ""
    #: ISO-8601 UTC, stamped by the installer.
    installed_at: str = ""

    @field_validator("source_project_id")
    @classmethod
    def _source_is_an_entity_id(cls, value: str) -> str:
        value = str(value or "").strip()
        if not is_valid_entity_id(value):
            raise ValueError(f"source_project_id {value!r} is not an entity id (uuid v4/v5)")
        return value


class DependenciesSpec(ProjectManifestSpec):
    """``deps.json`` — the manifest's shape, holding what this project
    INSTALLED from other projects' manifests. Only the row type and the
    uniqueness rule differ: two dependencies may share a source ``rel_path``
    (two projects can publish an asset at the same relative place)."""

    spec_kind: ClassVar[str] = "project.dependencies"

    entries: list[DependencySpec] = Field(default_factory=list)

    @field_validator("entries")
    @classmethod
    def _unique(cls, entries: list[DependencySpec]) -> list[DependencySpec]:
        seen: set[str] = set()
        for entry in entries:
            if entry.typeid in seen:
                raise ValueError(f"duplicate dependency {entry.typeid}")
            seen.add(entry.typeid)
        return entries
