"""``AppHub`` — the Flowpad hub as the help desk source reaches it on this machine.

The shared client's bearer, refresh and local-privacy gate, with its failures in the contract's
words a person can act on. Built by ``HelpdeskSource.build``; a test hands the source its own.
"""
from __future__ import annotations

from flow_sdk.sources import hub_conversations
from flow_sdk.sources.errors import SourceError


class AppHub(hub_conversations.AppHub):
    """The ``HubTransport`` a help desk source is built over: a refusal names the desk."""

    what = "desk"


def hub_refusal(exc: Exception, *, signed_in: bool) -> SourceError:
    """A hub failure as the contract error that decides whether a desk keeps polling."""
    return hub_conversations.hub_refusal(exc, signed_in=signed_in, what=AppHub.what)


__all__ = ["AppHub", "hub_refusal"]
