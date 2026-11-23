"""lw (langware) — the shapes of a statement doc's blocks.

A project's lw is its statement docs: plain markdown docs holding fenced YAML blocks.

    ```statements
    tag: machine_access.remote_control
    depends_on:
      - machine_access.privileged_access
    statements:
      - text: Remote control is flow connect with a node created locked.
        basis: stated
        issues:
          - No node carries a "locked" setting.
    ```

* A **statement** is architecture: one sentence that is true by design. ``issues`` are the
  violations found in today's code; none means it passes. It has no id.
* A **requirement** is implementation: one sentence of what must be built. Requirements are a
  list of the statements block they implement.
* A ``test_debug`` block is what tagit writes in a rules doc: the tests the rules are bound to
  (``sites``), when they were ``proven``, and the rules as ``statements``.
* A block is named by ``tag`` and names what it builds on in ``depends_on`` — tags, in the one
  grammar (``flow_sdk/tags/grammar.py``); another project's tag carries its ``--<ns>--`` prefix.

Reading a doc, the checks across docs and the writes live in ``flow_sdk/lw``. TS twin:
``ui/src/components/milkdown-editor/plugins/fence-render/renderers/lw-schema.ts``; parity is pinned by ``tests/fixtures/lw_blocks_contract.json``.
Stdlib + pydantic only, like the rest of ``data_spec``.
"""

from __future__ import annotations

import re
from typing import Any, ClassVar, Literal, Optional

from pydantic import Field, field_validator, model_validator

from flow_sdk.schema.data_spec.spec import DataSpec
from flow_sdk.tags.grammar import normalize_tag

STATEMENTS = "statements"
TEST_DEBUG = "test_debug"

def _tag(value: Any) -> str:
    """A tag exactly as it must be written: already lowercase, no surrounding spaces."""
    if not isinstance(value, str):
        raise ValueError("a tag must be a string")
    if normalize_tag(value) != value:
        raise ValueError("a tag is lowercase with no surrounding spaces")
    return value


def _sentence(value: Any) -> str:
    if not isinstance(value, str) or not value.strip():
        raise ValueError("must be a non-empty sentence")
    return value


def _inside_the_project(value: Any) -> str:
    """Mirror of ``is_safe_rel_path`` (``fs_store/origin/fs_origin.py``; TS ``isSafeRelPath``)."""
    p = value.strip().replace("\\", "/") if isinstance(value, str) else ""
    if not p or p.startswith("/") or (len(p) >= 2 and p[1] == ":") or ".." in p.split("/"):
        raise ValueError("must be a path inside the project")
    return value


_ABOUT = re.compile(r"^(.*):(\d+)$")


def split_about(value: str) -> tuple[str, Optional[int]]:
    """``path`` or ``path:line`` -> the path and its line."""
    found = _ABOUT.match(value)
    return (found.group(1), int(found.group(2))) if found else (value, None)


class LwSiteSpec(DataSpec):
    """A test the rules are bound to, relative to the project root."""

    spec_kind: ClassVar[str] = "lw.site"

    rel_path: str
    line: Optional[int] = Field(default=None, ge=1)
    note: Optional[str] = None

    _rel_path = field_validator("rel_path")(classmethod(lambda cls, v: _inside_the_project(v)))


class StatementSpec(DataSpec):
    """One sentence of architecture."""

    spec_kind: ClassVar[str] = "lw.statement"

    text: str
    #: ``stated`` by the owner, or ``proven`` by a test or a root cause.
    basis: Optional[Literal["stated", "proven"]] = None
    #: What in today's code violates the statement. Empty means it passes.
    issues: list[str] = []
    #: The files the statement is about: ``path`` or ``path:line``, from the project root.
    about: list[str] = []

    @model_validator(mode="before")
    @classmethod
    def _no_id_no_requirements(cls, value: Any) -> Any:
        if isinstance(value, dict):
            if "id" in value:
                raise ValueError("a statement has no id")
            if "requirements" in value or "changes" in value:
                raise ValueError("a statement has no requirements; they are the block's own requirements list")
        return value

    _text = field_validator("text")(classmethod(lambda cls, v: _sentence(v)))
    _issues = field_validator("issues")(classmethod(lambda cls, v: [_sentence(i) for i in v]))

    @field_validator("about")
    @classmethod
    def _about(cls, value: list[str]) -> list[str]:
        for item in value:
            path, line = split_about(item)
            _inside_the_project(path)
            if line == 0:
                raise ValueError("a line starts at 1")
        return value


class RequirementSpec(DataSpec):
    """One sentence of implementation."""

    spec_kind: ClassVar[str] = "lw.requirement"

    text: str

    _text = field_validator("text")(classmethod(lambda cls, v: _sentence(v)))


class _BlockSpec(DataSpec):
    """What every block has. A kind says everything else about itself here, once."""

    #: The fence language.
    kind: ClassVar[str]
    #: The fields as they are written, in order.
    fields: ClassVar[tuple[str, ...]]

    tag: str
    depends_on: list[str] = []

    _tag = field_validator("tag", mode="before")(classmethod(lambda cls, v: _tag(v)))

    @field_validator("depends_on", mode="before")
    @classmethod
    def _tags(cls, value: Any) -> Any:
        return [_tag(v) for v in value] if isinstance(value, list) else value

    @model_validator(mode="after")
    def _not_itself(self) -> "_BlockSpec":
        if self.tag in self.depends_on:
            raise ValueError("a block cannot depend on itself")
        return self


class StatementsBlockSpec(_BlockSpec):
    """A ``statements`` block: a tag, what it builds on, its statements, and the requirements that
    implement them."""

    spec_kind: ClassVar[str] = "lw.statements"
    kind: ClassVar[str] = STATEMENTS
    fields: ClassVar[tuple[str, ...]] = ("tag", "depends_on", "statements", "requirements")

    statements: list[StatementSpec] = Field(min_length=1)
    requirements: list[RequirementSpec] = []


class TestDebugBlockSpec(_BlockSpec):
    """A ``test_debug`` block: tagit's own fields (``sites``, ``proven``) around the shared ones."""

    __test__ = False  # not a pytest class
    spec_kind: ClassVar[str] = "lw.test_debug"
    kind: ClassVar[str] = TEST_DEBUG
    fields: ClassVar[tuple[str, ...]] = ("tag", "depends_on", "sites", "proven", "statements")

    sites: list[LwSiteSpec] = []
    #: When the rules were proven, and where: ``2026-08-13 · FLOWPAD-1980``.
    proven: Optional[str] = None
    statements: list[StatementSpec] = Field(min_length=1)


#: The fence languages lw owns, each with its shape.
BLOCK_SPECS: dict[str, type[_BlockSpec]] = {spec.kind: spec for spec in (StatementsBlockSpec, TestDebugBlockSpec)}
BLOCK_KINDS = tuple(BLOCK_SPECS)
