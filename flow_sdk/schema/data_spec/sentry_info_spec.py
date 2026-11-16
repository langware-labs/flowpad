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
from typing import Literal

from pydantic import ValidationError, field_validator

from flow_sdk.schema.data_spec.spec import DataSpec

logger = logging.getLogger(__name__)

#: ``https://<public key>@<host>/<numeric project id>`` -- and nothing else: no secret, no query,
#: no fragment, no path prefix. Kept identical to ``DSN_RE`` in ``ui/src/telemetry/sentry.ts`` (two
#: runtimes, one rule): change both together.
_DSN = re.compile(r"^https://[0-9a-f]{16,64}@[a-z0-9.-]+(?::\d{1,5})?/\d{1,20}$")

SentryEnvironment = Literal["development", "staging", "production"]


class SentryInfo(DataSpec):
    dsn: str
    environment: SentryEnvironment

    @field_validator("dsn")
    @classmethod
    def _public_dsn_only(cls, value: str) -> str:
        if not _DSN.match(value):
            raise ValueError("dsn must be https://<public_key>@<host>/<project_id>")
        return value


def parse_sentry_info(raw: object) -> SentryInfo | None:
    """The lenient entry point: a valid value, or ``None`` (logged) for anything else. Never raises.

    Every reader of a value that crossed a boundary (a hub answer, ``config.json``) goes through
    here, so a malformed value turns Sentry OFF instead of breaking bootstrap.
    """
    if raw is None:
        return None
    if isinstance(raw, SentryInfo):
        return raw
    try:
        return SentryInfo.model_validate(raw)
    except ValidationError:
        logger.warning("sentry_info: ignoring an invalid value")
        return None
