"""Dataset value models — ``ExampleSpec``, ``DatasetSpec``, and the three leaves.

``Spec`` is the suffix for a VALUE model: not an entity, never a row of its own.
The one entity is ``Dataset`` (``flow_sdk/builtin/dataset.py``); everything here
lives inside it or on disk as JSON.

Generics type the slots. ``ExampleSpec[I, O, C]`` says what one example's
``input`` / ``output`` / ``context`` are; ``DatasetSpec[E]`` says what every row
is. ``DatasetSpec[MyExample]`` validates rows as ``MyExample`` — a dataset can be
typed by the agent that produced it. A PARAMETRIZATION inherits its origin's
``spec_kind`` and deliberately does not register; only a named subclass does.

The three leaves are what a slot holds when it is a FILE, a FOLDER, or a CSV
cell. A ``str`` is not a ``DataSpec``, so a cell needs ``TextSpec``; and the
file/folder distinction is the TYPE — a lone file is a ``FileRef``, never a
one-member folder.
"""

from __future__ import annotations

from typing import Any, Generic, Optional, TypeVar, Union

from pydantic import Field

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec, to_authoring_form


class DataLayoutEnum(StrEnum):
    """How a dataset's examples are physically stored on disk."""

    CSV = "csv"               # one delimited file; each row is an example
    IO_FOLDER = "io_folder"   # a folder of per-example input/output/ground_truth slots


class ExampleKind(StrEnum):
    """Per-example role. 'The eval set' = examples whose kind == EVAL."""

    TRAIN = "train"
    EVAL = "eval"
    TEST = "test"


# ── the leaves ────────────────────────────────────────────────────────────────

class FileRef(DataSpec):
    """A file: its example-relative POSIX path. Resolved by the layout, never here."""

    spec_kind = "file_ref"
    path: str


class FolderSpec(DataSpec):
    """A folder of files: its own example-relative path and its members, recursively."""

    spec_kind = "folder"
    path: str
    files: dict[str, Union["FileRef", "FolderSpec"]] = Field(default_factory=dict)


class TextSpec(DataSpec):
    """A literal — a CSV cell."""

    spec_kind = "text"
    text: str


#: What an un-spec'd slot may hold.
Artifact = Union[FileRef, FolderSpec, TextSpec]

FolderSpec.model_rebuild()


# ── one example ───────────────────────────────────────────────────────────────

InputSpecT = TypeVar("InputSpecT", bound=DataSpec)
OutputSpecT = TypeVar("OutputSpecT", bound=DataSpec)
ContextSpecT = TypeVar("ContextSpecT", bound=DataSpec)


class ExampleSpec(DataSpec, Generic[InputSpecT, OutputSpecT, ContextSpecT]):
    """One example: ``input`` + ``output`` + ``context``, plus the gold answer.

    ``output`` and ``ground_truth`` share a shape — that is what makes scoring a
    structural diff. Either may be absent: gold only (hand-authored, not yet
    run), produced only (captured, not yet annotated), or neither (unlabeled).
    N occurrences on disk (``output-1``, ``output-2``) arrive as ``list[O]``.

    ``kind`` is the ROW role (train/eval/test) — a field. The registration hook
    is ``spec_kind``, so the two never collide.
    """

    id: str = ""                                 # layout-assigned
    kind: ExampleKind = ExampleKind.TRAIN
    input: InputSpecT
    output: Optional[Union[OutputSpecT, list[OutputSpecT]]] = None
    ground_truth: Optional[Union[OutputSpecT, list[OutputSpecT]]] = None
    context: Optional[ContextSpecT] = None
    metadata: dict[str, Any] = Field(default_factory=dict)  # example.json metadata ∪ sidecars by filename
    data: dict[str, Any] = Field(default_factory=dict)

    @property
    def layout(self) -> Optional[str]:
        return self.metadata.get("layout")

    @classmethod
    def slot_type(cls, slot: int) -> Any:
        """The ``I``/``O``/``C`` of a parametrization, by slot. THE one place
        that knows the generic arg order — no caller reaches into pydantic."""
        args = cls.__pydantic_generic_metadata__["args"]
        return args[slot] if args and slot < len(args) else None

    @classmethod
    def input_type(cls) -> Any:
        return cls.slot_type(0)

    @classmethod
    def output_type(cls) -> Any:
        return cls.slot_type(1)

    @classmethod
    def context_type(cls) -> Any:
        return cls.slot_type(2)


# ── the dataset ───────────────────────────────────────────────────────────────

ExampleSpecT = TypeVar("ExampleSpecT", bound=ExampleSpec)


class DatasetSpec(DataSpec, Generic[ExampleSpecT]):
    """A dataset: a list of examples of one shape."""

    examples: list[ExampleSpecT]

    @classmethod
    def example_type(cls) -> type:
        """The ``E`` of a parametrization."""
        (e,) = cls.__pydantic_generic_metadata__["args"] or (ExampleSpec,)
        return e

    @classmethod
    def parse(cls, data: Any) -> type:
        """The keyword authoring form → ``DatasetSpec[ExampleSpec[I, O, C]]``.

            {"examples": [{"input": <shape>, "output": <shape>, "context"?: <shape>}]}

        One row describes every row (the list carries exactly one element).
        ``output`` and ``ground_truth`` share ``O``; if both are authored they
        must agree.
        """
        if isinstance(data, type):
            return data
        if isinstance(data, str):
            from flow_sdk.schema.data_spec._kinds import resolve_kind  # noqa: PLC0415
            from flow_sdk.tags.grammar import normalize_tag  # noqa: PLC0415

            found = resolve_kind(normalize_tag(data))
            if not (isinstance(found, type) and issubclass(found, DatasetSpec)):
                raise ValueError(f"{data!r} is not a registered dataset shape")
            return found
        if not isinstance(data, dict) or set(data) != {"examples"}:
            raise ValueError('a dataset shape is {"examples": [<one example shape>]}')
        rows = data["examples"]
        if not isinstance(rows, list) or len(rows) != 1:
            raise ValueError("a dataset shape carries exactly one example shape — the shape every row has")
        row = rows[0]
        if not isinstance(row, dict) or "input" not in row:
            raise ValueError('an example shape needs at least "input"')
        extra = set(row) - {"input", "output", "ground_truth", "context"}
        if extra:
            raise ValueError(f"unknown example slots: {sorted(extra)}")
        out_form = row.get("output", row.get("ground_truth"))
        if "output" in row and "ground_truth" in row and row["output"] != row["ground_truth"]:
            raise ValueError("output and ground_truth share one shape")
        i = DataSpec.parse(row["input"])
        o = DataSpec.parse(out_form) if out_form is not None else DataSpec
        c = DataSpec.parse(row["context"]) if "context" in row else DataSpec
        hit = DatasetSpec[ExampleSpec[i, o, c]]  # type: ignore[valid-type]   (Pydantic caches parametrizations)
        if hit.__authoring__ is None:
            # Remember the form, so `to_authoring_form` — the ONE serializer — can
            # emit it back; a parametrization has no spec_kind and no fields to describe.
            form: dict[str, Any] = {"input": to_authoring_form(i)}
            if o is not DataSpec:
                form["output"] = to_authoring_form(o)
            if c is not DataSpec:
                form["context"] = to_authoring_form(c)
            hit.__authoring__ = {"examples": [form]}
        return hit


#: What an un-spec'd dataset validates with.
DEFAULT_DATASET_SPEC = DatasetSpec[ExampleSpec[Artifact, Artifact, DataSpec]]  # type: ignore[valid-type]
