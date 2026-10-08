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

* **implicit** -- read from the body: ``fields`` is a ``record``, ``examples`` is a ``dataset``;
* **explicit** -- ``subkind`` declared, and a body that does not match is refused;
* **none** -- no body at all: a documentation node for a branch of the ontology. It registers
  nothing, so the kind stays anonymous (the ontology's rule: a kind names a shape or nothing).
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

from pydantic import field_validator, model_validator

from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.frontmatter import AssetDocumentSpec
from flow_sdk.schema.data_spec.io.native import Text
from flow_sdk.schema.data_spec.spec import DataSpec

Subkind = Literal["record", "dataset"]
#: The example slots a ``dataset`` definition may name (``ExampleSpec``'s three type slots).
DATASET_SLOTS = ("input", "output", "context")


class DataSchemaField(DataSpec):
    """One field of a ``record``: its shape and what it means."""

    spec_kind: ClassVar[str] = "data_schema.field"

    shape: ShapeForm
    description: str = ""


class DataSchemaDocSpec(AssetDocumentSpec):
    """``data_schema.json`` -- the entity document of a ``data_schema`` asset."""

    main_file: ClassVar[str | None] = "data_schema.json"
    manifest_layout: ClassVar[str | None] = "entity"

    subkind: Optional[Subkind] = None
    #: ``record``: field name -> its shape and meaning.
    fields: Optional[dict[str, DataSchemaField]] = None
    #: ``dataset``: the example slots (``input`` required; ``output`` / ``context``) -> shapes.
    examples: Optional[dict[str, ShapeForm]] = None
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
        bodies = [name for name, body in (("record", self.fields), ("dataset", self.examples)) if body]
        if len(bodies) > 1:
            raise ValueError(f"a data schema defines one shape; this one has {' and '.join(bodies)}")
        if self.subkind and bodies != [self.subkind]:
            found = bodies[0] if bodies else "no body"
            raise ValueError(f"subkind {self.subkind!r} declared, but the body is {found}")
        if self.examples is not None:
            if "input" not in self.examples:
                raise ValueError('a dataset data schema names its "input" slot')
            extra = set(self.examples) - set(DATASET_SLOTS)
            if extra:
                raise ValueError(f"unknown example slots {sorted(extra)}; a slot is one of {DATASET_SLOTS}")
        return self

    @property
    def resolved_subkind(self) -> Optional[Subkind]:
        """Declared, else read from the body, else None (a documentation node)."""
        if self.subkind:
            return self.subkind
        if self.fields:
            return "record"
        if self.examples:
            return "dataset"
        return None


__all__ = ["DATASET_SLOTS", "DataSchemaDocSpec", "DataSchemaField", "Subkind"]
