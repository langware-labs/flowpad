"""``ShapeForm`` — a declared shape, held as DATA.

``SpecType`` held a live Python CLASS in a pydantic field. It was the one place
a ``DataSpec`` carried something that is not data, which is exactly why it
needed a custom serializer to survive JSON at all: the validator compiled the
authoring form on the way in, and the serializer un-compiled it on the way out.

Nine fields declared it. **One** place ever needs the class
(``core/compute/declared_value.to_declared``, which validates a value against a
declared shape); another converted it straight back to the form to put in a
prompt — form → class → form, for nothing. So the field keeps the form, and the
one caller compiles when it needs a type. ``_COMPILED`` already caches by
canonical form, so that is a dict hit, not a re-parse.

What is NOT lost: the form is still validated at the write, where the file is
still in hand and the author can be told which key is wrong. That was the real
value of the old validator, and it is the whole of this module.
"""

from __future__ import annotations

from typing import Annotated, Any, Union

from pydantic import BeforeValidator

from flow_sdk.schema.data_spec.spec import DataSpec, _normalize_form


def normalize_shape_form(value: Any) -> Any:
    """Validate and normalize an authoring form, returning it as DATA.

    A class is accepted and rendered back to its form, so a caller that already
    has a type — and every document round-tripped through the old
    ``SpecType`` — keeps working.
    """
    if value is None:
        return None
    if isinstance(value, type):
        from flow_sdk.schema.data_spec.spec import to_authoring_form  # noqa: PLC0415 — cycle-safe

        return to_authoring_form(value)
    # Raises on a malformed kind, at the write. Structure is untouched.
    return _normalize_form(value)


def compile_form(form: Any) -> Any:
    """An authoring form → the type it names. The inverse, for the one caller
    that genuinely needs a class (``declared_value.to_declared``)."""
    return None if form is None else DataSpec.parse(form)


def is_shape_form(annotation: Any) -> bool:
    """Does this annotation declare a shape (rather than hold a value)?

    By IDENTITY of the validator, not by its repr: a caller matching the string
    ``"normalize_shape_form"`` stops matching the moment the function is
    renamed or wrapped, and then silently takes the wrong branch.
    """
    from typing import get_args  # noqa: PLC0415

    for arg in get_args(annotation):
        for meta in get_args(arg)[1:] or ():
            if getattr(meta, "func", None) is normalize_shape_form:
                return True
        for meta in (getattr(arg, "__metadata__", ()) or ()):
            if getattr(meta, "func", None) is normalize_shape_form:
                return True
    return any(getattr(m, "func", None) is normalize_shape_form
               for m in (getattr(annotation, "__metadata__", ()) or ()))


#: A field that declares a SHAPE. Holds the authoring form — a kind name, an
#: object, or a one-element list — never a class.
ShapeForm = Annotated[Union[str, dict, list], BeforeValidator(normalize_shape_form)]


__all__ = ["ShapeForm", "compile_form", "is_shape_form", "normalize_shape_form"]
