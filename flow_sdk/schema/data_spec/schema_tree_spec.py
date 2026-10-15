"""``SchemaTreeSpec`` — the schemas one project defines, and how they hang together.

One answer for the schema tree of a project: every schema a data schema folder of the project
defines, the kinds each one names, and the dataset that keeps its rows. A kind a field names is
either LINKED (a dataset keeps rows of it, the field holds a reference to one) or held INSIDE the
row (nobody keeps rows of it) -- the schema writes both the same way, so the tree says which.
"""

from __future__ import annotations

from typing import ClassVar, Literal, Optional

from flow_sdk.schema.data_spec._form import ShapeForm
from flow_sdk.schema.data_spec.data_schema_spec import DataSchemaRule, Subkind
from flow_sdk.schema.data_spec.spec import DataSpec

Held = Literal["inside", "link"]


class SchemaFieldSpec(DataSpec):
    """One field of a kind (for a ``dataset`` kind: one example slot)."""

    spec_kind: ClassVar[str] = "schema.tree.field"

    name: str
    shape: Optional[ShapeForm] = None
    description: str = ""
    required: bool = True


class SchemaUseSpec(DataSpec):
    """A kind another kind's fields name."""

    spec_kind: ClassVar[str] = "schema.tree.use"

    kind: str
    held: Held
    #: The project that defines the kind; ``""`` when no project's schema folder does (ours, in code).
    project_id: str = ""


class SchemaDatasetSpec(DataSpec):
    """The dataset that keeps a kind's rows."""

    spec_kind: ClassVar[str] = "schema.tree.dataset"

    id: str
    title: str = ""
    rows: int = 0
    #: The data source whose items the dataset curates; ``""`` when it is written by hand.
    source_id: str = ""


class SchemaNodeSpec(DataSpec):
    """One schema a project's data schema folder defines."""

    spec_kind: ClassVar[str] = "schema.tree.node"

    kind: str
    #: The folder name: the kind without its namespace.
    name: str
    subkind: Subkind
    description: str = ""
    #: Where it is defined, from the project folder.
    folder: str
    fields: list[SchemaFieldSpec] = []
    rules: list[DataSchemaRule] = []
    uses: list[SchemaUseSpec] = []
    dataset: Optional[SchemaDatasetSpec] = None


class SchemaTreeSpec(DataSpec):
    """Every schema one project defines, in the order its folders are read."""

    spec_kind: ClassVar[str] = "schema.tree"

    schemas: list[SchemaNodeSpec] = []


__all__ = ["Held", "SchemaDatasetSpec", "SchemaFieldSpec", "SchemaNodeSpec", "SchemaTreeSpec", "SchemaUseSpec"]
