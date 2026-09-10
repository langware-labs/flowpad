"""The ``switch-mode`` request body — a union tagged on ``mode``.

The two directions do not take the same arguments: →interactive spawns a PTY and
pins the palette it is rendered into; →cli kills one and carries nothing. A flat
body could not say that (``theme`` would be legal on a request with no terminal),
so each arm declares only its own fields and the inherited ``extra="forbid"``
rejects the other's. Mirrored in TS by ``SwitchModeBody`` (``agentic-types.ts``).
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import Field, TypeAdapter, ValidationError

from flow_sdk.builtin.agentic_process.status_predicates import WorkerMode
from flow_sdk.schema.data_spec.spec import DataSpec

#: The two palettes a worker can be pinned to. Anything else is not a theme.
TerminalTheme = Literal["light", "dark"]


class SwitchToInteractiveBody(DataSpec):
    """→terminal: spawn the PTY worker for this session."""

    mode: Literal[WorkerMode.INTERACTIVE]
    #: Sampled per launch, because the CLI reads its palette once at startup.
    #: Omitted leaves the worker's previously pinned theme in place.
    theme: TerminalTheme | None = None


class SwitchToCliBody(DataSpec):
    """→chat: kill the PTY and route headless. No terminal ⇒ no arguments."""

    mode: Literal[WorkerMode.CLI]


#: PTY dimensions are deliberately absent from BOTH arms. They seed the client's
#: own ``attachPty`` and have never been read by any handler; carrying them here
#: is what left ``cols``/``rows`` advertised in this action's docstring for
#: months without a single reader (FLOWPAD-2130).
SwitchModeBody = Annotated[
    Union[SwitchToInteractiveBody, SwitchToCliBody],
    Field(discriminator="mode"),
]

_ADAPTER: TypeAdapter[Union[SwitchToInteractiveBody, SwitchToCliBody]] = TypeAdapter(SwitchModeBody)

_EXPECTED = f"expected {WorkerMode.INTERACTIVE.value!r} or {WorkerMode.CLI.value!r}"


class SwitchModeBodyError(ValueError):
    """A body matching neither arm. Carries a message meant for the caller."""


def parse_switch_mode_body(body: dict) -> Union[SwitchToInteractiveBody, SwitchToCliBody]:
    """Validate a raw request body into the arm its ``mode`` selects."""
    try:
        return _ADAPTER.validate_python(body)
    except ValidationError as exc:
        raise SwitchModeBodyError(_explain(body, exc)) from exc


def _explain(body: dict, exc: ValidationError) -> str:
    """A one-line reason. A bad tag is its own sentence — every other arm error
    is noise once the discriminator itself is wrong."""
    if any(err["type"] in ("union_tag_invalid", "union_tag_not_found") for err in exc.errors()):
        return f"unknown mode {str(body.get('mode', '')).lower()!r} ({_EXPECTED})"
    fields = ", ".join(".".join(str(p) for p in err["loc"][1:]) or "body" for err in exc.errors())
    return f"invalid switch-mode body for mode={body.get('mode')!r}: {fields}"
