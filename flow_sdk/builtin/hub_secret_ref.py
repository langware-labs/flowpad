"""Flowpad Hub secret pointer.

The hub is the system of record, and a secret there is named the same way it is
named here: ``(project_id, ENV_VAR_NAME)``. So this locator carries those two
fields rather than an opaque ``secret_id`` — the coordinates ARE the identity,
and an opaque id would be a second name for the same thing, free to drift.

``secret_id`` survives as an accepted alias so a payload minted before the
re-key still validates. Nothing writes it, but it is still read: it is the
fallback name in ``HubSecretDriver._coords`` and is accepted by
``membership_sync``.

Values resolve through ``HubSecretDriver`` against the hub's consent-gated,
audited ``env-var/<NAME>/value`` route.
"""
from __future__ import annotations

from typing import Literal

from flow_sdk.builtin.secret_origin_locator import SecretOriginLocator


class HubSecretRef(SecretOriginLocator):
    kind: Literal["flowpad-hub"] = "flowpad-hub"
    project_id: str = ""
    name: str = ""
    #: Legacy/opaque coordinate. Accepted (and read as a name fallback) so older
    #: payloads still resolve; never written.
    secret_id: str = ""
