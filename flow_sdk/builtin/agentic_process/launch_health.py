"""Why an agent launch failed — the reusable classification.

Spawning a worker fails in many distinguishable ways: the harness is not
installed, the user is not logged in, no API key is stored, the model is
overloaded, the process died a second after launch. Today every one of those
collapses into ``WorkerStatus.ERROR`` plus a free-text ``start_failure``
string, and ``ProcessError`` carries neither a code nor a retryability. The
frontend loader is reduced to regex-matching the English message
(``load-process.ts``, whose own comment admits those are "the only signals
available"), and every new caller invents its own guess.

This is a leaf module on purpose — no imports from the package it lives in —
so any caller can classify without a cycle, the way ``worker_status`` does.

**Deliberately shaped like ``flow_sdk/ingest/health.py``.** Ingestion already
settled this exact question for data sources, and the contract transfers
verbatim: ``config_error`` needs a human and must NOT be auto-relaunched;
``transient_error`` means the next *naturally occurring* attempt may succeed.
Unrecognised failures classify transient, because guessing "permanent" would
latch a working harness off.

The two enums stay separate rather than shared: ingestion's has
``never_synced``, which is meaningless for a launch, and pointing the agent
layer at the ingest package would invert the dependency. Two enums, one
documented contract, and ``as_source_error`` converts at the seam.
"""
from __future__ import annotations

from typing import TYPE_CHECKING, Any, Optional

from flow_sdk._compat import StrEnum

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.builtin.agentic_process.cli_drivers.auth_probe import WorkerAuthResult


class LaunchHealth(StrEnum):
    OK = "ok"
    #: Needs a human. Do NOT auto-relaunch — this is the latch state.
    CONFIG_ERROR = "config_error"
    #: May fix itself; the next natural attempt is the retry. Never schedule one.
    TRANSIENT_ERROR = "transient_error"


class LaunchErrorCode(StrEnum):
    """The taxonomy that did not exist. Values are stable wire strings — they
    reach the UI as ``start_failure_code`` and the bus as ``agent.launch_failed``."""

    NOT_INSTALLED = "not_installed"
    NOT_AUTHENTICATED = "not_authenticated"
    NO_API_KEY = "no_api_key"
    MODEL_UNAVAILABLE = "model_unavailable"
    COMPUTE_NODE_MISSING = "compute_node_missing"
    FORK_SOURCE_MISSING = "fork_source_missing"
    INSTANT_EXIT = "instant_exit"
    CRASH_SIGNAL = "crash_signal"
    INTERRUPTED = "interrupted"
    CANCELLED = "cancelled"
    TIMEOUT = "timeout"
    UNKNOWN = "unknown"


class LaunchError(Exception):
    """A classified launch failure."""

    def __init__(self, health: LaunchHealth, code: LaunchErrorCode, detail: str = "",
                 worker_type: str = ""):
        super().__init__(f"{code}: {detail}" if detail else str(code))
        self.health = health
        self.code = code
        self.detail = detail
        self.worker_type = worker_type

    def __repr__(self) -> str:  # pragma: no cover — diagnostics only
        return f"LaunchError({self.health}, {self.code}, {self.detail!r})"

    @classmethod
    def config(cls, code: LaunchErrorCode, detail: str = "", worker_type: str = "") -> "LaunchError":
        return cls(LaunchHealth.CONFIG_ERROR, code, detail, worker_type)

    @classmethod
    def transient(cls, code: LaunchErrorCode, detail: str = "", worker_type: str = "") -> "LaunchError":
        return cls(LaunchHealth.TRANSIENT_ERROR, code, detail, worker_type)

    def as_dict(self) -> dict[str, str]:
        """The wire shape — one field set for the bus, the journal and the UI."""
        return {
            "health": str(self.health),
            "code": str(self.code),
            "detail": self.detail,
            "worker_type": self.worker_type,
        }

    def as_source_error(self):
        """Convert at the ingestion seam, preserving the health verdict.

        A missing harness parks a DataSource as ``config_error``; an overloaded
        model retries on the next due tick. Two taxonomies, one contract.
        """
        from flow_sdk.ingest.health import SourceError, SourceHealth  # noqa: PLC0415

        health = (SourceHealth.CONFIG_ERROR if self.health is LaunchHealth.CONFIG_ERROR
                  else SourceHealth.TRANSIENT_ERROR)
        return SourceError(health, str(self.code), self.detail)

    @classmethod
    def from_auth(cls, auth: "WorkerAuthResult", worker_type: str = "") -> Optional["LaunchError"]:
        """The pre-check bridge: a probe verdict → a launch verdict, or None.

        ``UNKNOWN`` is deliberately NOT a failure. The probe's own contract says
        it must never conflate "could not decide" with "logged out", and
        latching a harness off because a 5-second probe was inconclusive would
        be exactly that mistake.
        """
        status = str(getattr(auth, "status", "") or "")
        if status == "not_installed":
            return cls.config(LaunchErrorCode.NOT_INSTALLED,
                              getattr(auth, "message", "") or "harness is not installed",
                              worker_type)
        if status == "logged_out":
            return cls.config(LaunchErrorCode.NOT_AUTHENTICATED,
                              getattr(auth, "message", "") or "harness is not logged in",
                              worker_type)
        return None

    @classmethod
    def classify(cls, exc: BaseException, worker_type: str = "") -> "LaunchError":
        """Any exception → a verdict. Unrecognised ⇒ transient, same rule and
        same reason as ``ingest.health.classify``."""
        if isinstance(exc, LaunchError):
            return exc
        name = type(exc).__name__
        text = str(exc)
        lowered = text.lower()
        if isinstance(exc, TimeoutError) or name == "TimeoutError":
            return cls.transient(LaunchErrorCode.TIMEOUT, text, worker_type)
        if name == "CancelledError":
            return cls.transient(LaunchErrorCode.CANCELLED, text, worker_type)
        # WorkerSpawnError is raised for a harness that discovery cannot locate
        # or whose exe vanished after discovery — both need a human.
        if name == "WorkerSpawnError" or "no " in lowered and "installation discovered" in lowered:
            return cls.config(LaunchErrorCode.NOT_INSTALLED, text, worker_type)
        if "command not found" in lowered:
            return cls.config(LaunchErrorCode.NOT_INSTALLED, text, worker_type)
        return cls.transient(LaunchErrorCode.UNKNOWN, f"{name}: {text}", worker_type)


async def ensure_launchable(worker_type: Optional[str] = None, *,
                           check_auth: bool = True) -> Optional[LaunchError]:
    """Cheap pre-flight: can this harness run at all? ``None`` means yes.

    Turns the two most common launch failures into a verdict BEFORE a PTY is
    materialised — the same shape ``sync_source`` already uses when it checks
    ``capabilities_ready()`` before doing any work. Both probes read the
    discovery SSOT and are bounded by the probe's own 5s cap; neither raises.

    The two checks cost very different amounts. ``is_installed`` is a lookup in
    the discovery dict — the same SSOT ``worker_path_env`` reads at spawn, so an
    install verdict here can never disagree with the spawn. ``is_logged_in``
    actually runs the vendor CLI (``claude auth status`` / ``codex login
    status``) in a subprocess, uncached, up to ``PROBE_TIMEOUT_SECONDS``.

    ``check_auth=False`` runs only the install check. It exists for callers on a
    user-facing request path — ``createProcess`` gates every new session on this
    — where paying a subprocess probe per call would tax the happy path to catch
    a rarer failure. Those callers accept that a logged-out harness still fails
    at launch, where it is latched and reported as it is today.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    name = str(worker_type or "")
    try:
        if not await AgenticProcess.is_installed(worker_type):
            return LaunchError.config(
                LaunchErrorCode.NOT_INSTALLED, "harness is not installed", name
            )
        if not check_auth:
            return None
        auth: Any = await AgenticProcess.is_logged_in(worker_type)
    except Exception as exc:  # noqa: BLE001 — a pre-check must never be the failure
        return LaunchError.classify(exc, name)
    return LaunchError.from_auth(auth, name)


def emit_launch_failed(error: LaunchError, target: str) -> None:
    """Announce a classified launch failure on the bus.

    Mirrors ``ingest.sync``'s failed-sync emission field-for-field, so a
    consumer reads the same ``code``/``detail`` names on both families.
    Best-effort: reporting a failure must not become one.
    """
    try:
        from flow_sdk.tags import emit_tag  # noqa: PLC0415

        emit_tag("agent.launch_failed", target, error.as_dict())
    except Exception:  # noqa: BLE001
        pass


__all__ = [
    "LaunchHealth", "LaunchErrorCode", "LaunchError",
    "ensure_launchable", "emit_launch_failed",
]
