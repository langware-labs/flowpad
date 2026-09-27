"""``ConfirmSpec`` — a yes/no answered by the button a person presses.

The shape of an ``ask`` op that asks permission rather than a value. It has no
fields ON PURPOSE: the ask window draws one input per field, so an empty kind
draws none, leaving only the two buttons — worded by the op's
``submit_label`` / ``cancel_label`` (default Send / Cancel). Send answers ``{}``;
Cancel is the ask op's own ``cancelled`` answer.
There is no ``yes: bool`` field, because a field would be a text box a person
could type ``false`` into and still send.
"""

from __future__ import annotations

from typing import ClassVar

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec


class ConfirmSpec(DataSpec):
    model_config = ConfigDict(frozen=True)
    spec_kind: ClassVar[str] = "confirm"
