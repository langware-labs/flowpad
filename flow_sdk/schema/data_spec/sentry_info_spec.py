"""Browser error-reporting config the hub hands the shared UI — ``BootstrapInfo.sentry_info``.

One definition for both servers: the hub builds it from its ``ServiceConfig`` and returns it from
its own bootstrap; a sandbox pulls the same value from the hub and stamps it onto its bootstrap.
A desktop never has one (``null``), so the UI never starts Sentry there.

A Sentry DSN is a PUBLIC client key (it ships in every browser that reports), never a credential:
the validator refuses the legacy ``key:secret@`` form so a secret can never ride this field.
"""

from __future__ import annotations

import logging
import re

from pydantic import ValidationError, field_validator

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

#: ``https://<public key>@<host>/<numeric project id>`` -- and nothing else: no secret, no query,
#: no fragment, no path prefix. Kept identical to ``DSN_RE`` in ``ui/src/telemetry/sentry.ts`` (two
#: runtimes, one rule): change both together.
_DSN = re.compile(r"^https://[0-9a-f]{16,64}@[a-z0-9.-]+(?::[0-9]{1,5})?/[0-9]{1,20}$")


class SentryEnvironment(StrEnum):
    """The environments a hub reports as (its ``DEPLOY_ENV``, ``local`` excluded: a local hub is off).
    A closed set on purpose: a new one needs a wheel update."""

    DEVELOPMENT = "development"
    STAGING = "staging"
    PRODUCTION = "production"


class SyncOutcome(StrEnum):
    UPDATED = "updated"  # the hub answered a new value
    UNCHANGED = "unchanged"  # the hub re-confirmed the stored value (freshness renewed)
    CLEARED = "cleared"  # the hub answered null (or an invalid value): off
    UNSUPPORTED = "unsupported"  # the hub has no such action (an older hub): off
    KEPT = "kept"  # no authoritative answer (offline, 5xx, no hub, another refusal): stored value untouched
    SIGNED_OUT = "signed_out"  # no hub login to ask with: stored value untouched
    PRIVACY_LOCAL = "privacy_local"  # Local privacy mode: nothing may leave the box


class SentryInfo(DataSpec):
    dsn: str
    environment: SentryEnvironment

    @field_validator("dsn")
    @classmethod
    def _public_dsn_only(cls, value: str) -> str:
        # fullmatch + [0-9]: `$` would let a trailing newline through and `\d` matches any Unicode digit.
        if not _DSN.fullmatch(value):
            raise ValueError("dsn must be https://<public_key>@<host>/<project_id>")
        return value


class SentryInfoStatus(DataSpec):
    """What ``GET @local/sentry-info`` answers: the effective value and how fresh the hub's word is."""

    sentry_info: SentryInfo | None = None
    synced_at: str | None = None
    expired: bool = False


class SentryInfoSyncResult(SentryInfoStatus):
    """What ``POST @local/sentry-info`` answers: the status after the sync, and how it went."""

    outcome: SyncOutcome


def parse_sentry_info(raw: object) -> SentryInfo | None:
    """The lenient entry point: a valid value, or ``None`` (logged) for anything else. Never raises.

    Every reader of a value that crossed a boundary (a hub answer, ``config.json``) goes through
    here, so a malformed value turns Sentry OFF instead of breaking bootstrap.
    """
    if raw is None:
        return None
    if isinstance(raw, SentryInfo):
        return raw
    if isinstance(raw, dict):
        # A FOREIGN dict (the hub's answer, config.json): read the two fields we know, field by field.
        # `extra="forbid"` is for programmers building a value, not for a later hub adding a field --
        # that must not switch Sentry off on every box still running this wheel.
        raw = {"dsn": raw.get("dsn"), "environment": raw.get("environment")}
    try:
        return SentryInfo.model_validate(raw)
    except ValidationError:
        logger.warning("sentry_info: ignoring an invalid value")
        return None
