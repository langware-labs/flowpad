"""``DataSpec`` — the base of every shape.

A shape declared in *source* is a subclass. A shape that arrives **as data** —
a dataset's contract in ``dataset.json``, an agent's ``input``/``output`` in its
frontmatter — is parsed by ``DataSpec.parse`` into an *anonymous* subclass via
``create_model``. Either way it is a real Pydantic class: validation, error
reporting and JSON Schema are Pydantic's own. One type system, not two, and a
field typed ``DataSpec`` means "any shape."

The authoring form has NO keywords. It mirrors a Python annotation one-to-one,
and those are the only three shapes an annotation can take:

    "string"                      ->  str            (a bare kind)
    {"category": "string", ...}   ->  class X: category: str   (an object)
    ["string"]                    ->  list[str]      (a one-element list)

A dict is ALWAYS an object whose keys are field names, so ``{"kind": "int"}``
is a one-field object called ``kind`` — which is why the registration hook is
named ``spec_kind``, not ``kind``: a user must be free to author a field of
that name.

``spec_kind`` is the connector between a shape and a value: an ordinary
dot-path tag (``flow_sdk/tags/grammar.py``) resolved through the ONE
``SchemaRegistry``. Reserved primitives resolve to Python types; a registered
kind to its class; anything else is **anonymous** — legal, opaque (``Any``),
never minted. A named subclass registers itself; a Pydantic parametrization
(``ExampleSpec[A, B]``) inherits its origin's kind and deliberately does NOT.

A shape is a CLASS, and a class is not a Pydantic value: a field that holds one
is typed ``SpecType``, whose validator reads the authoring form and whose
serializer emits it back — that is what keeps ``agent.json`` human-readable.
"""

from __future__ import annotations

import hashlib
import json
from typing import Annotated, Any, ClassVar, get_args, get_origin

from pydantic import BaseModel, BeforeValidator, ConfigDict, PlainSerializer, create_model, model_validator

from flow_sdk.schema.data_spec._namespace import current as current_ns, qualified
from flow_sdk.tags.grammar import normalize_tag

# Compiled anonymous subclasses, keyed by canonical authoring form so two
# identical shapes share one class.
_COMPILED: dict[str, type] = {}


class DataSpec(BaseModel):
    """The base of every shape. Subclass it; or let ``parse`` subclass it for you."""

    #: The shape's name in the tag ontology. ``""`` ⇒ anonymous (unregistered).
    spec_kind: ClassVar[str] = ""
    #: The authoring form an anonymous subclass was compiled from — what it
    #: dumps back to. ``None`` on hand-written subclasses.
    __authoring__: ClassVar[Any] = None

    #: ``frozen``: a spec is a VALUE — a launch payload, a file header, an
    #: ingestion envelope. Nothing downstream may edit one in place and hand it
    #: on, because the next reader would have no way to tell what it was handed.
    #: Build a changed one with ``model_copy(update=...)``.
    #:
    #: ``extra="forbid"``: a misspelled key must fail loudly rather than yield a
    #: row with an empty field. The corollary is that a constructor reading a
    #: FOREIGN dict must project field by field rather than splat it — the hop is
    #: deliberately lossy, and that is the contract.
    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _refuse_bare_generic(cls, value: Any) -> Any:
        """An unparametrized generic silently validates against its TypeVar
        BOUNDS (``DataSpec`` has no required fields, so junk passes). Refuse it.
        A non-generic class has no parameters, so this is a no-op everywhere else."""
        if cls.__pydantic_generic_metadata__["parameters"]:
            raise TypeError(
                f"{cls.__name__} is generic — validate through a parametrization "
                f"({cls.__name__}[...]), not the bare class"
            )
        return value

    @classmethod
    def __pydantic_init_subclass__(cls, **kwargs: Any) -> None:
        """Register a NAMED subclass under its kind. ``__pydantic_init_subclass__``
        (not ``__init_subclass__``) is the hook that sees the built ``model_fields``."""
        super().__pydantic_init_subclass__(**kwargs)
        assert "spec_kind" not in cls.model_fields, (
            f"{cls.__name__}: `spec_kind` is a ClassVar — annotating it makes it a field"
        )
        # The class's OWN declaration, never an inherited one. A subclass that
        # names no kind inherits the ClassVar, and registering it rebinds the
        # parent's name to the narrower class: ``FileDataPage`` did exactly that
        # to ``DataPage``, so ``source.page`` resolved to the subclass and a
        # plain page no longer validated against its own kind.
        declares_own = "spec_kind" in cls.__dict__
        if declares_own and cls.spec_kind and cls.__pydantic_generic_metadata__["origin"] is None:
            from flow_sdk.fs_store.schema_registry import SchemaRegistry  # lazy: avoid import cycle

            # Whose ontology this kind belongs to. The loader importing an
            # externally authored asset declares it, so such an asset cannot mint
            # into ours even by declaring the same string a shipped asset does.
            # Ours declares nothing and the kind is written bare.
            SchemaRegistry.register_kind(qualified(cls.spec_kind, current_ns()), cls)

    @classmethod
    def parse(cls, data: Any) -> type:
        """The authoring form → a type. Idempotent on a type."""
        if isinstance(data, type) or get_origin(data) is list:
            return data
        return _compile(_normalize_form(data))


def _compile(form: Any) -> type:
    """A NORMALIZED form → a type. Children are already normalized, so this
    never re-walks them — the top-level ``_normalize_form`` is the one pass."""
    if isinstance(form, str):
        from flow_sdk.schema.data_spec._kinds import resolve_kind  # lazy: registry import

        return resolve_kind(form)
    if isinstance(form, list):
        return list[_compile(form[0])]  # type: ignore[misc]
    key = _canonical(form)
    hit = _COMPILED.get(key)
    if hit is None:
        hit = create_model(  # type: ignore[call-overload]
            "Spec_" + hashlib.sha1(key.encode()).hexdigest()[:8],
            __base__=DataSpec,
            spec_kind=(ClassVar[str], ""),
            __authoring__=(ClassVar[Any], form),
            **{name: (_compile(child), ...) for name, child in form.items()},
        )
        _COMPILED[key] = hit
    return hit


def _normalize_form(form: Any) -> Any:
    """Kind strings through the tag grammar, structure untouched. Raises on a
    malformed kind — at the write, where the file is still in hand."""
    if isinstance(form, str):
        return normalize_tag(form)
    if isinstance(form, dict):
        return {name: _normalize_form(child) for name, child in form.items()}
    if isinstance(form, list):
        if len(form) != 1:
            raise ValueError(
                "a list shape carries exactly one element — the shape every "
                f"element has; got {len(form)}"
            )
        return [_normalize_form(form[0])]
    raise ValueError(
        f"a shape is a kind string, an object or a one-element list; got {type(form).__name__}"
    )


def _canonical(form: Any) -> str:
    return json.dumps(form, sort_keys=True, separators=(",", ":"))


def to_authoring_form(t: Any) -> Any:
    """A type → the authoring form that produces it. Inverse of ``parse``."""
    from flow_sdk.schema.data_spec._kinds import PRIMITIVE_NAMES  # noqa: PLC0415

    if t in PRIMITIVE_NAMES:
        return PRIMITIVE_NAMES[t]
    if get_origin(t) is list:
        (inner,) = get_args(t)
        return [to_authoring_form(inner)]
    if getattr(t, "spec_kind", ""):
        return t.spec_kind
    if getattr(t, "__authoring__", None) is not None:
        return t.__authoring__
    from flow_sdk.fs_store.schema_registry import SchemaRegistry  # noqa: PLC0415

    kind = SchemaRegistry.kind_for(t)
    if kind is not None:
        return kind
    fields = getattr(t, "model_fields", None)
    if fields is not None:   # a hand-written, unregistered subclass: describe it
        return {name: to_authoring_form(field.annotation) for name, field in fields.items()}
    raise ValueError(f"no authoring form for {t!r}")


class Tagged:
    """``Tagged[T]`` — a field holding a VALUE whose concrete class is restored by kind.

    A dump adds ``spec_kind`` beside the value's fields; a load pops it, resolves the class
    through the registry and validates the rest as that class, then Pydantic checks it against
    ``T``. A dict without ``spec_kind`` validates as ``T`` itself, so ``Item(data={...})`` keeps
    reading naturally. An unregistered class dumps without a tag and cannot be restored — that
    is the point of registering.
    """

    def __class_getitem__(cls, item: Any) -> Any:
        return Annotated[item, BeforeValidator(_by_kind), PlainSerializer(_with_kind, return_type=dict)]


def _by_kind(value: Any) -> Any:
    if not isinstance(value, dict) or "spec_kind" not in value:
        return value
    from flow_sdk.schema.data_spec._kinds import resolve_kind  # noqa: PLC0415 — registry import

    rest = dict(value)
    kind = rest.pop("spec_kind")
    shape = resolve_kind(kind)
    if shape is Any:
        raise ValueError(f"unknown spec_kind {kind!r}: the class must be registered before its values are read")
    return shape.model_validate(rest)


def _with_kind(value: DataSpec, info: Any) -> dict:
    dumped = value.model_dump(mode=info.mode)
    return {"spec_kind": value.spec_kind, **dumped} if value.spec_kind else dumped


#: A field that HOLDS a shape (a class). The validator reads the authoring
#: form; the serializer emits it back, so JSON/YAML dumps stay compact. Declare
#: it ``Optional[SpecType]`` — Pydantic short-circuits ``None`` OUTSIDE the
#: ``Annotated``, so neither hook ever sees it.
SpecType = Annotated[type, BeforeValidator(DataSpec.parse), PlainSerializer(to_authoring_form, return_type=Any)]
