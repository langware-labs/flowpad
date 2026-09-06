"""Health and error classification for data sources.

The only behavioural distinction that matters: **``config_error`` stops polling
that scope; ``transient_error`` never does.** A source whose credential expired
or whose feed URL is not XML cannot be fixed by trying again, so retrying it
every minute forever is pure waste and hides the real state behind a spinner. A
5xx or a connection reset is retried at the ordinary cadence — the cadence *is*
the retry rate, and no backoff ladder is introduced on top of it.

Unrecognised failures classify as transient. Guessing "permanent" on an error we
have not seen before would silently stop a working source.
"""
from __future__ import annotations

from flow_sdk._compat import StrEnum

#: How much of a failure's detail a row keeps. The cursor row and the source
#: row hold the same kind of text and are read in the same card, so the bound
#: is stated once here, beside `classify` and `SourceError` — the rest of the
#: failure contract.
ERROR_DETAIL_MAX = 500


class SourceHealth(StrEnum):
    NEVER_SYNCED = "never_synced"
    OK = "ok"
    #: Needs a human (or a capability) — polling for this scope is SKIPPED.
    CONFIG_ERROR = "config_error"
    #: May fix itself — retried at the normal cadence.
    TRANSIENT_ERROR = "transient_error"


#: Worst-of precedence for rolling child cursor health up onto a DataSource.
#: A source with one broken feed is not "ok", and a config error outranks a
#: transient one because it is the state that needs a person.
_PRECEDENCE = {
    SourceHealth.CONFIG_ERROR: 3,
    SourceHealth.TRANSIENT_ERROR: 2,
    SourceHealth.NEVER_SYNCED: 1,
    SourceHealth.OK: 0,
}


def worst_of(healths) -> SourceHealth:
    """The health a parent should report given its children's."""
    worst = SourceHealth.OK
    seen = False
    for h in healths:
        seen = True
        value = SourceHealth(h)
        if _PRECEDENCE[value] > _PRECEDENCE[worst]:
            worst = value
    return worst if seen else SourceHealth.NEVER_SYNCED


class SourceError(Exception):
    """A classified failure raised by a driver.

    Drivers raise this instead of returning a status so an unexpected exception
    can never be mistaken for a clean empty poll.
    """

    def __init__(self, health: SourceHealth, code: str, detail: str = ""):
        super().__init__(f"{code}: {detail}" if detail else code)
        self.health = health
        self.code = code
        self.detail = detail

    @classmethod
    def config(cls, code: str, detail: str = "") -> "SourceError":
        return cls(SourceHealth.CONFIG_ERROR, code, detail)

    @classmethod
    def transient(cls, code: str, detail: str = "") -> "SourceError":
        return cls(SourceHealth.TRANSIENT_ERROR, code, detail)

    @classmethod
    def for_no_status(cls, reason: str, *, not_configured_code: str) -> "SourceError":
        """A failure with no HTTP status at all: the backend is not configured
        or the caller is signed out — a person's to fix — else the connection
        dropped and the next tick is the retry."""
        if "not configured" in (reason or ""):
            return cls.config(not_configured_code, reason)
        return cls.transient("network", reason)

    @classmethod
    def for_status(cls, status: int, hint: str = "") -> "SourceError":
        """THE status→health table. One copy, because a second one diverges:
        a 429 read as permanent parks a source forever over a rate limit."""
        detail = f"HTTP {status}{f' — {hint}' if hint else ''}"
        if status in (401, 403):
            return cls.config("unauthorized", detail)
        if status == 404:
            return cls.config("not_found", detail)
        if status == 429:
            # Transient by definition: the next due tick IS the retry, which is
            # why no backoff budget is introduced here.
            return cls.transient("rate_limited", detail)
        if 400 <= status < 500:
            return cls.config("client_error", detail)
        return cls.transient("server_error", detail)


def classify(exc: BaseException) -> tuple[SourceHealth, str, str]:
    """``(health, code, detail)`` for any exception a driver may surface.

    Drivers raise pre-classified ``SourceError``s (see ``ingest/http.py``);
    anything else reaching here is unrecognised, and an unrecognised failure is
    transient — guessing "permanent" would silently stop a working source.
    """
    if isinstance(exc, SourceError):
        return exc.health, exc.code, exc.detail
    return SourceHealth.TRANSIENT_ERROR, type(exc).__name__, str(exc)
