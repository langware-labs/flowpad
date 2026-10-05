"""Decision APIs behind a hub ``APIEndpoint``: one dialect per vendor, picked by the target host.

A dialect is ``PATH`` (the vendor path under the endpoint), ``to_wire`` and ``from_wire``.
The host is the one fact the endpoint carries about which vendor it fronts, so it picks
the dialect; an endpoint marked ``decision`` whose host no dialect claims is refused with a
sentence saying so, rather than sent a body it would reject.
"""

from __future__ import annotations

from types import ModuleType

from flow_sdk.external_apis.decision import jev
from flow_sdk.external_apis.decision.errors import DecisionError, DecisionFailure, reason_for_status

_DIALECTS: tuple[ModuleType, ...] = (jev,)


def dialect_for_host(host: str) -> ModuleType:
    host = (host or "").lower()
    for dialect in _DIALECTS:
        if host in dialect.HOSTS:
            return dialect
    raise DecisionError(
        "no_endpoint", f"The decision endpoint fronts {host or 'an unknown host'}, which no decision dialect speaks"
    )


__all__ = ["DecisionError", "DecisionFailure", "dialect_for_host", "reason_for_status"]
