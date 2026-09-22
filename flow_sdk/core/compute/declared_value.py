"""Reading a call's RETURNED VALUE, and holding it to the shape it declared.

A call answers on one of two channels, and they are not the same kind of text:

* **stdout** — machine output. A shell one-liner's answer IS its stdout; JSON
  when it parses as JSON, the trimmed text otherwise. Nothing wraps it.
* **a reply** — an agent's prose. The value, when there is one, is usually
  fenced inside a sentence that explains it, because that is what a model
  writes when asked for both. So a fence is tried first, and only then the
  whole text.

Keeping them apart is deliberate. Teaching the stdout rule about fences would
change what an existing command returns the day its output happened to contain
one; teaching the reply rule about them costs nothing, because prose that is
not a value falls through to being the value as text either way.

``to_declared`` is the shared half: ONE place turns a declared authoring form
into a type and checks a value against it. It raises rather than formatting a
message, because each caller names the thing that failed differently — an op
names its rung, a turn names its persona.
"""

from __future__ import annotations

import json
import re
from typing import Any, Optional

#: The last fenced ``json`` block in a reply. Last, not first: a model that
#: shows its working fences an example before the answer.
_JSON_FENCE = re.compile(r"```(?:json)?\s*(\{.*?\}|\[.*?\])\s*```", re.DOTALL)


class DeclaredShapeError(ValueError):
    """A value does not satisfy the shape its callee declared."""


def value_from_stdout(stdout: "Optional[str]") -> Any:
    """What a COMMAND returned, read off its stdout.

    JSON when stdout parses as JSON, otherwise the trimmed text. A shell
    one-liner's answer is its stdout; there is no other channel, and the
    declared shape decides whether what came back is acceptable.
    """
    text = (stdout or "").strip()
    if not text:
        return None
    try:
        return json.loads(text)
    except ValueError:
        return text


def value_from_reply(reply: "Optional[str]") -> Any:
    """What an AGENT returned, read off its prose.

    The last fenced JSON block if there is one, else the whole reply parsed as
    JSON, else the trimmed prose itself. An agent asked for a shaped answer
    writes the shape and a sentence about it; an agent asked for nothing in
    particular writes a sentence, and the sentence is the value.
    """
    text = (reply or "").strip()
    if not text:
        return None
    fenced = _JSON_FENCE.findall(text)
    if fenced:
        try:
            return json.loads(fenced[-1])
        except ValueError:
            pass
    try:
        return json.loads(text)
    except ValueError:
        return text


def to_declared(value: Any, shape: Any) -> Any:
    """*value*, validated against the authoring *shape* — or ``DeclaredShapeError``.

    A declared shape the value does not satisfy is a FAILURE, not a warning: a
    caller binding that value into a later step would otherwise carry the
    breakage forward to somewhere it cannot be explained.

    ``shape`` is an authoring form (``ShapeForm``), not a type; ``compile_form``
    is the one thing that turns one into a type, and this is the one place the
    result is applied to a value.
    """
    from pydantic import TypeAdapter  # noqa: PLC0415

    from flow_sdk.schema.data_spec._form import compile_form  # noqa: PLC0415

    try:
        return TypeAdapter(compile_form(shape)).validate_python(value)
    except Exception as error:  # noqa: BLE001 — pydantic and compile_form both raise their own
        raise DeclaredShapeError(str(error)) from error
