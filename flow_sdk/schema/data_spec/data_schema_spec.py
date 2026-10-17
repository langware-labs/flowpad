"""``data_schema.json`` — a SCHEMA defined as an asset, not as code.

``agentic-assets/data_schema/<full.kind>/`` is a folder whose name IS the kind it defines
(``navigator.decision``); ``data_schema.json`` holds the schema and ``description.md`` says what
it means. Indexing the folder compiles the schema into a ``DataSpec`` class and registers it under
that kind (``declared.py``), in the namespace of the project it lives in -- ours bare, anyone
else's ``--ns--.``-prefixed, exactly like a schema a data driver's code defines. A data schema may
nest further data schemas in its own ``agentic-assets/``; nesting decides where a definition lives
and travels, never who owns it.

The document is itself a value -- of the kind ``data_schema``, whose schema is ``DataSchemaDocSpec``.

The definition's VARIANT (its subkind) is optional:

* **implicit** -- read from the body: ``fields`` is a ``record``, ``rows`` is a ``dataset``;
* **explicit** -- ``subkind`` declared, and a body that does not match is refused;
* **none** -- no body at all: a documentation node for a branch of the ontology. It registers
  nothing, so the kind stays anonymous (the ontology's rule: a kind names a shape or nothing).
"""

from __future__ import annotations

import re
from typing import ClassVar, Literal, Optional

from pydantic import field_validator, model_validator

from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.io.native import Text
from flow_sdk.schema.data_spec.spec import DataSpec

Subkind = Literal["record", "dataset"]
#: The row slots a ``dataset`` definition may name (``RowSpec``'s three type slots).
DATASET_SLOTS = ("input", "output", "context")


#: An owner's name -- a schema field's ``owned_by``, a mirror's ``by``: one word.
OWNER_WORD = re.compile(r"[a-z0-9][a-z0-9_-]*")


class DataSchemaField(DataSpec):
    """One field of a ``record``: its shape and what it means."""

    spec_kind: ClassVar[str] = "data_schema.field"

    shape: ShapeForm
    description: str = ""
    #: Who owns the field's value when it is a copy of an outside system's (``"crm"``): only a
    #: writer that says it writes as that owner (``put(..., by="crm")``) may set or change it.
    owned_by: Optional[str] = None

    @field_validator("owned_by")
    @classmethod
    def _an_owner_is_a_word(cls, owner: Optional[str]) -> Optional[str]:
        if owner is not None and not OWNER_WORD.fullmatch(owner):
            raise ValueError("owned_by names the owner in a word: a-z 0-9 _ - (\"crm\")")
        return owner


class DataSchemaRule(DataSpec):
    """A rule across rows a ``record`` declares -- one of:

    ``{"same": ["persona.icp", "icp"]}``: the two paths, walked from a row along its link fields
    (``*`` = every element of a list), must name the same row wherever both ends are set (the
    persona is one of the row's ICP's).

    ``{"unique": ["crm_id"]}``: no two rows of one dataset hold the same value in these fields
    (several fields: the same COMBINATION). A row that leaves any of them empty is not judged.

    Checked on every write and every read of the rows -- by Flowpad, so every writer keeps it."""

    spec_kind: ClassVar[str] = "data_schema.rule"

    same: Optional[list[str]] = None
    unique: Optional[list[str]] = None
    description: str = ""

    @model_validator(mode="after")
    def _one_rule(self) -> "DataSchemaRule":
        if (self.same is None) == (self.unique is None):
            raise ValueError('a rule is one of {"same": [path, path]} or {"unique": [field, ...]}')
        if self.same is not None and (len(self.same) != 2 or not all(isinstance(p, str) and p and all(p.split(".")) for p in self.same)):
            raise ValueError('a rule names exactly two paths: {"same": ["persona.icp", "icp"]}')
        if self.unique is not None and (not self.unique or len(set(self.unique)) != len(self.unique)
                                        or not all(isinstance(f, str) and f and "." not in f and f != "*" for f in self.unique)):
            raise ValueError('unique names one or more of the record\'s own fields, each once: {"unique": ["crm_id"]}')
        return self


class DataSchemaDocSpec(AssetDocumentSpec):
    """``data_schema.json`` -- the entity document of a ``data_schema`` asset."""

    main_file: ClassVar[str | None] = "data_schema.json"
    manifest_layout: ClassVar[str | None] = "entity"

    subkind: Optional[Subkind] = None
    #: ``record``: field name -> its shape and meaning.
    fields: Optional[dict[str, DataSchemaField]] = None
    #: ``dataset``: the example slots (``input`` required; ``output`` / ``context``) -> shapes.
    rows: Optional[dict[str, ShapeForm]] = None
    #: ``record`` only: other record kinds whose fields (and rules) this one has too -- shared
    #: fields defined once. A field of the same name here is an error, never a silent override.
    include: Optional[list[str]] = None
    #: ``record`` only: rules across rows (``DataSchemaRule``).
    rules: Optional[list[DataSchemaRule]] = None
    #: Whose ontology this kind belongs to, when it must differ from its project's.
    ns: Optional[str] = None
    description: Text = Text("")

    @field_validator("ns")
    @classmethod
    def _a_usable_namespace(cls, ns: Optional[str]) -> Optional[str]:
        """The marker grammar's own check (``join_namespace``), at the read -- a bad name is a bad
        document, never a crash of whatever indexes it."""
        if ns:
            from flow_sdk.tags.grammar import join_namespace  # noqa: PLC0415

            join_namespace(ns, "")
        return ns

    @model_validator(mode="after")
    def _one_body_matching_the_subkind(self) -> "DataSchemaDocSpec":
        bodies = [name for name, body in (("record", self.fields or self.include), ("dataset", self.rows)) if body]
        if len(bodies) > 1:
            raise ValueError(f"a data schema defines one shape; this one has {' and '.join(bodies)}")
        if self.subkind and bodies != [self.subkind]:
            found = bodies[0] if bodies else "no body"
            raise ValueError(f"subkind {self.subkind!r} declared, but the body is {found}")
        if self.rules and not (self.fields or self.include):
            raise ValueError("rules belong to a record (a schema with fields)")
        if self.include is not None and (not self.include or len(set(self.include)) != len(self.include)
                                         or not all(isinstance(k, str) and k for k in self.include)):
            raise ValueError('include names one or more record kinds, each once: {"include": ["crm.tagged"]}')
        if self.rows is not None:
            if "input" not in self.rows:
                raise ValueError('a dataset data schema names its "input" slot')
            extra = set(self.rows) - set(DATASET_SLOTS)
            if extra:
                raise ValueError(f"unknown row slots {sorted(extra)}; a slot is one of {DATASET_SLOTS}")
        return self

    @property
    def resolved_subkind(self) -> Optional[Subkind]:
        """Declared, else read from the body, else None (a documentation node)."""
        if self.subkind:
            return self.subkind
        if self.fields or self.include:
            return "record"
        if self.rows:
            return "dataset"
        return None


__all__ = ["DATASET_SLOTS", "DataSchemaDocSpec", "DataSchemaField", "DataSchemaRule", "Subkind"]
