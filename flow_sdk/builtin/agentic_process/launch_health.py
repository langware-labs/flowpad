"""Why an agent launch failed — the reusable classification.

Spawning a worker fails in many distinguishable ways: the harness is not
installed, the user is not logged in, no API key is stored, the model is
overloaded, the process died a second after launch. Today every one of those
collapses into ``WorkerStatus.ERROR`` plus a free-text ``start_failure``
string, and a returned ``NOT_YET`` carries neither a code nor a retryability. The
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
    FOLDER_NOT_TRUSTED = "folder_not_trusted"
    FIRST_RUN_SETUP = "first_run_setup"
    BYPASS_WARNING = "bypass_warning"
    SIGNED_OUT = "signed_out"  # NOT_AUTHENTICATED is its legacy alias
    KEY_REJECTED = "key_rejected"
    BUDGET_NOT_READY = "budget_not_ready"
    CLI_CRASHED = "cli_crashed"
    PINNED_SOURCE_UNAVAILABLE = "pinned_source_unavailable"


#: code → (health, card fix); unlisted codes read as unknown. Then LLMSourceRefusal → code (else signed_out).
CODE_TABLE = {c: ("transient_error" if f in ("wait", "retry") else "config_error", f) for c, f in (
    ("folder_not_trusted", "trust_folder"), ("first_run_setup", "finish_setup"), ("bypass_warning", "accept_bypass"),
    ("signed_out", "connect"), ("not_authenticated", "connect"), ("key_rejected", "replace_key"), ("budget_not_ready", "wait"),
    ("not_installed", "install"), ("cli_crashed", "reinstall"), ("pinned_source_unavailable", "ask_owner"), ("unknown", "retry"))}
SERVER_FIXES = ("trust_folder", "finish_setup", "accept_bypass")  # done by the driver's apply_launch_fix
BLOCKING_CODES = {code for code, (_, fix) in CODE_TABLE.items() if fix in SERVER_FIXES}  # prompts on screen
CLI_CRASHES: dict[str, str] = {}  # worker_type → stderr of a CLI the last login probe saw crash


def code_for_refusal(refusal: str | None) -> "LaunchErrorCode":
    code = "pinned_source_unavailable" if refusal == "pinned_elsewhere" else str(refusal or "")
    return LaunchErrorCode(code if code in CODE_TABLE and code != "unknown" else "signed_out")


def launch_refusal(message: str, failure: dict):  # legacy message + data.launch_failure; 400 needs a person, 503 waits
    from flow_sdk.responses.response import ApiFailResponse  # noqa: PLC0415

    status = 400 if failure.get("health") == "config_error" else 503
    return ApiFailResponse(message=message, data={"launch_failure": failure}, status_code=status)


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
    def of(cls, code: LaunchErrorCode | str, detail: str = "", worker_type: str = "") -> "LaunchError":
        return cls(LaunchHealth(CODE_TABLE.get(code, CODE_TABLE["unknown"])[0]), LaunchErrorCode(code), detail, worker_type)

    def wire(self, phase: str = "spawn", *, evidence: str = "", facts: dict | None = None) -> dict:
        from flow_sdk.schema.data_spec.launch_failure_spec import LaunchFailureSpec  # noqa: PLC0415

        return LaunchFailureSpec(code=self.code, health=self.health, worker_type=self.worker_type, phase=phase,
                                 detail=self.detail, evidence=evidence.strip()[-2048:], fix=CODE_TABLE.get(self.code, CODE_TABLE["unknown"])[1],
                                 facts={k: v for k, v in (facts or {}).items() if v}).model_dump(mode="json")

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
        if type(exc.__cause__).__name__ == "LLMSourceError":  # a spawn refused for funding
            return cls.classify(exc.__cause__, worker_type)
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
        if name == "LLMSourceError":  # the top refusal names the card; a rejected key outranks it
            codes = [getattr(src, "reason_code", "") for src in getattr(exc, "sources", [])]
            refusal = "budget_not_ready" if getattr(exc, "budget_not_ready", False) else (
                "key_rejected" if "key_rejected" in codes else next((c for c in codes if c), ""))
            return cls.of(code_for_refusal(refusal), text, worker_type)
        return cls.transient(LaunchErrorCode.UNKNOWN, text or name, worker_type)


async def ensure_launchable(worker_type: Optional[str] = None) -> Optional[LaunchError]:
    """Cheap pre-flight: can this harness run at all? ``None`` means yes.

    Turns the two most common launch failures into a verdict BEFORE a PTY is
    materialised — the same shape ``sync_source`` already uses when it checks
    ``capabilities_ready()`` before doing any work. Both probes read the
    discovery SSOT and are bounded by the probe's own 5s cap; neither raises.
    """
    from flow_sdk.builtin.agentic_process import AgenticProcess  # noqa: PLC0415

    name = str(worker_type or "")
    try:
        if not await AgenticProcess.is_installed(worker_type):
            return LaunchError.config(
                LaunchErrorCode.NOT_INSTALLED, "harness is not installed", name
            )
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
