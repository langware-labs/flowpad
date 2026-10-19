"""Why a hub call did not do what was asked — the one vocabulary every surface reads.

A hub call fails in five ways that call for five different responses from the person:

* ``offline`` — no answer at all (DNS, refused, timeout). Wait; it is sent when the hub is back.
* ``not_configured`` — this app has no hub. Nothing to wait for.
* ``signed_out`` — the credential is missing or dead. Sign in.
* ``rejected`` — the hub answered and refused (a 4xx with its own reason). Read the reason.
* ``server_error`` — the hub or the load balancer in front of it broke (5xx, 408/425/429, a body
  that is not JSON). Wait and retry.

Produced once, by ``HubError`` (``flow_sdk/cloud_client/shared/errors.py``), carried unchanged to
the UI as ``data.error_code`` and recorded on an undelivered message as its ``delivery_failure``.
The UI matches the ``kind``, never the ``message`` prose.
"""

from __future__ import annotations

from enum import Enum
from typing import ClassVar, Optional

from pydantic import ConfigDict

from flow_sdk.schema.data_spec.spec import DataSpec


class HubFailureKind(str, Enum):
    OFFLINE = "offline"
    NOT_CONFIGURED = "not_configured"
    SIGNED_OUT = "signed_out"
    REJECTED = "rejected"
    SERVER_ERROR = "server_error"

    @property
    def stays_owed(self) -> bool:
        """Whether something that failed this way is retried by itself.

        ``rejected`` waits for the person — the hub said no, and asking again unchanged is
        the same no. Every other kind is a condition that passes.
        """
        return self is not HubFailureKind.REJECTED


class HubFailure(DataSpec):
    """One failed hub call, as a value."""

    model_config = ConfigDict(extra="forbid", frozen=True)
    spec_kind: ClassVar[str] = "hub.failure"

    kind: HubFailureKind
    #: The HTTP status the hub (or what stands in front of it) answered; None when nothing answered.
    status: Optional[int] = None
    #: The hub's machine-readable ``data.error_code`` (``target_not_found``, ``unauthenticated``), or a
    #: local one (``local_source_missing``, ``hub_too_old``).
    code: Optional[str] = None
    #: One sentence for a person. Never a response body that was not JSON.
    message: str = ""
