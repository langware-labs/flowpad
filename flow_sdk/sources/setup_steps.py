"""Named setup steps a source declares — what a setup wizard's steps call.

A connection comes with wizards (``setup_wizards``); their ops are shell one-liners, and a step that needs
the provider — "is this app id real", "subscribe this number's webhook" — has to reach the driver's own
code. The driver declares that code here, the machinery asks:

    @setup_step("account")
    async def _account(self, *, check: bool, values: Mapping[str, str]) -> ReturnedValue: ...

``flow source step <source> account [--check]`` (``DataSource.step``) opens the source — its config may still
be incomplete, that is what setup is for — and calls it. ``check`` asks only whether the goal already holds
(the op's completion check); without it the step does the work. ``values`` are what the wizard's asks bound.

A step never writes a row or a secret itself. When it has learned something to keep, its answer's ``value``
is a :class:`SourceUpdateSpec` and ``DataSource.step`` stores it: config on the source, allowed senders on
its row, secrets into the driver's credential (by ``auth.vars`` key). The secrets never travel back out.
"""
from __future__ import annotations

from typing import Any, Callable, ClassVar, Optional, TypeVar

from pydantic import ConfigDict, Field

from flow_sdk.schema.data_spec.returned_value_spec import ReturnedValue
from flow_sdk.schema.data_spec.spec import DataSpec

_STEP_ATTR = "__flow_setup_step__"
#: Steps every source answers, whatever its driver (``DataSource.step``):
#: a public URL for this machine (a driver with a ``webhook`` block);
PUBLIC_WEBHOOK = "public-webhook"
#: the driver's own ``verify`` — the source becomes active when it passes;
VERIFY = "verify"
#: the owning agent has a local deployment serving, so what arrives gets an answer;
ANSWERED = "answered"
#: a message from an allowed sender, and one after it going back — the conversation works.
FIRST_TURN = "first-turn"
GENERIC_STEPS = frozenset({PUBLIC_WEBHOOK, VERIFY, ANSWERED, FIRST_TURN})

F = TypeVar("F", bound=Callable[..., Any])


def setup_step(name: str) -> Callable[[F], F]:
    """Declare the decorated coroutine method as the source's setup step ``name``."""

    def mark(fn: F) -> F:
        setattr(fn, _STEP_ATTR, name)
        return fn

    return mark


def setup_steps(cls: type) -> dict[str, str]:
    """``{step name: method name}`` of every step ``cls`` (and its bases) declares."""
    out: dict[str, str] = {}
    for attr in dir(cls):
        name = getattr(getattr(cls, attr, None), _STEP_ATTR, None)
        if isinstance(name, str):
            out[name] = attr
    return out


class SourceUpdateSpec(DataSpec):
    """What a setup step learned and wants kept. Every part is optional."""

    spec_kind: ClassVar[str] = "source.setup_update"
    model_config = ConfigDict(frozen=True)

    #: Merged into the source's config (the file).
    config: dict[str, Any] = Field(default_factory=dict)
    #: Replaces the row's allowed senders.
    allowed_senders: Optional[list[str]] = None
    #: ``{auth.vars key: value}`` — stored into the driver's credential, never echoed.
    secrets: dict[str, str] = Field(default_factory=dict)


__all__ = [
    "ANSWERED", "FIRST_TURN", "GENERIC_STEPS", "PUBLIC_WEBHOOK", "VERIFY", "ReturnedValue", "SourceUpdateSpec", "setup_step", "setup_steps",
]
