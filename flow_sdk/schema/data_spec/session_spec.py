"""Live-session settings that travel between tiers."""

from typing import ClassVar

from flow_sdk.schema.data_spec.spec import DataSpec


class SessionStartSettings(DataSpec, frozen=True):
    """Settings the guest proposes on the prompt that OPENS a session.

    Rides the starting prompt's ``remote_worker_session-<id>`` carrier as
    ``prompt_preview = {"session_start": {...}}`` — a hub-known Attachment
    field, so it survives the hub round-trip untouched. The host adopts it
    fill-only; afterwards the session's own ``reply_policy`` is authoritative.
    """

    spec_kind: ClassVar[str] = "session.start"

    reply_policy: str = "auto"
