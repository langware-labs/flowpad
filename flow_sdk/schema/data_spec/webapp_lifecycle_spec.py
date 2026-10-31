"""A web app's lifecycle on this machine: one record, typed failures, learned handlings.

The contract is ``docs/webapp-lifecycle.md``. Three values:

* ``webapp.lifecycle`` — THE answer to "is this app up here, and if not, what is being done about it". One per
  app per instance (``core/webapp/record``), never committed with the app. Every caller and screen reads it;
  nothing else decides readiness (``core/webapp/readiness``).
* ``webapp.failure`` — one thing that went wrong, typed: its phase, a closed ``code``, and a ``fingerprint`` that
  CODE computes from the normalized text, so two occurrences of the same failure are recognized as one.
* ``webapp.handling`` — what fixes a failure, learned once: matched by fingerprint (or a pattern) before any
  agent runs, executed by code from a closed set of actions. Lives in the app's ``setup/webapp_handlings.json``,
  so it travels with the app.
"""

from __future__ import annotations

from datetime import datetime, timedelta
from typing import ClassVar, Optional

from pydantic import ConfigDict, Field

from flow_sdk._compat import StrEnum
from flow_sdk.schema.data_spec.spec import DataSpec

#: How long a fingerprint the fixer agent already tried waits before the agent is tried on it again. Policy
#: (the user's D3 decision: an agent runs once per unknown failure), not a wait anything sleeps on — the
#: ladder reads it to decide, and a failure inside it goes to ``needs_person``. Changing it needs the user.
AGENT_COOLDOWN = timedelta(minutes=30)


class LifecycleState(StrEnum):
    DOWN = "down"
    INSTALLING = "installing"
    BUILDING = "building"
    STARTING = "starting"
    UP = "up"
    #: Up, but its page reported an error after it settled: shown, with a banner, while recovery decides.
    DEGRADED = "degraded"
    #: Recovering: a handling, a deterministic action or the fixer agent is working on ``failure``.
    RECOVERING = "recovering"
    FAILED = "failed"
    #: Nothing automatic is left: the failure's handling says so, or the agent already tried it.
    NEEDS_PERSON = "needs_person"


#: States in which the app's page may be shown.
SHOWABLE = (LifecycleState.UP, LifecycleState.DEGRADED)
#: States in which work is going on.
BUSY = (LifecycleState.INSTALLING, LifecycleState.BUILDING, LifecycleState.STARTING, LifecycleState.RECOVERING)


class FailurePhase(StrEnum):
    INSTALL = "install"
    BUILD = "build"
    START = "start"
    HEALTH = "health"
    PAGE = "page"
    PROBE = "probe"
    DEPENDENCY = "dependency"
    SETUP = "setup"


class FailureCode(StrEnum):
    PORT_HELD = "port_held"
    PORT_CONFLICT = "port_conflict"
    WRONG_PORT = "wrong_port"
    EXITED = "exited"
    PORT_NEVER_OPENED = "port_never_opened"
    HEALTH_NO_ANSWER = "health_no_answer"
    HEALTH_404 = "health_404"
    SERVER_ERROR = "server_error"
    OUT_OF_MEMORY = "out_of_memory"
    COMMAND_FAILED = "command_failed"
    TIMEOUT = "timeout"
    JS_ERROR = "js_error"
    CONSOLE_ERROR = "console_error"
    REQUEST_FAILED = "request_failed"
    NOT_ANSWERING = "not_answering"
    NOT_SETTLED = "not_settled"
    DEPENDENCY_DOWN = "dependency_down"
    FOLDER_GONE = "folder_gone"
    NO_PLACEMENT = "no_placement"
    BAD_HANDLINGS = "bad_handlings"
    SETUP_OWED = "setup_owed"
    UNKNOWN = "unknown"


class WebappFailureSpec(DataSpec):
    """One failure, typed. ``fingerprint`` is ``core/webapp/failure.fingerprint`` of the other fields — never
    written by hand, never by an agent."""

    spec_kind: ClassVar[str] = "webapp.failure"

    phase: FailurePhase
    code: FailureCode = FailureCode.UNKNOWN
    #: Where it was seen: ``step`` (a setup step), ``probe``, ``page``, ``console``, ``network``, ``relay``.
    source: str = "step"
    #: Normalized text (``core/webapp/failure.normalize``): ports, hashes, line:col, pids, ids stripped.
    text: str = ""
    fingerprint: str = ""
    #: The text as it was said, for a person and the agent.
    raw: str = ""
    #: Which process of the app, ``""`` for its page.
    process: str = ""
    at: Optional[datetime] = None


class AttemptCounter(DataSpec):
    """What recovery already tried for ONE fingerprint on this machine."""

    spec_kind: ClassVar[str] = "webapp.attempts"

    fingerprint: str
    #: Times a learned handling ran for it.
    handled: int = 0
    #: Times a deterministic action (by its code) ran for it.
    deterministic: int = 0
    #: Times the fixer agent ran for it.
    agent: int = 0
    last_agent_at: Optional[datetime] = None


class WebappLifecycleSpec(DataSpec):
    """THE record of one web app on this machine. Written only by ``core/webapp/record``."""

    spec_kind: ClassVar[str] = "webapp.lifecycle"
    model_config = ConfigDict(extra="ignore", frozen=True)

    webapp_id: str
    project_id: str = ""
    state: LifecycleState = LifecycleState.DOWN
    #: What is happening now, one line ("installing with `npm ci`", "restarting", "the fixer is working").
    detail: str = ""
    #: The step a recovery is on (``handling:<id>``, ``restart``, ``agent``), while ``state`` is RECOVERING.
    recovery: str = ""
    since: Optional[datetime] = None
    checked_at: Optional[datetime] = None
    #: Live port per process (``""`` = the page), as last found.
    ports: dict[str, int] = Field(default_factory=dict)
    #: Pid per process Flowpad started (and of a running install/build), for adoption and Stop.
    pids: dict[str, int] = Field(default_factory=dict)
    #: Content stamps of the last good install/build (``core/webapp/stamps``): a cut-short one has none.
    install_stamp: str = ""
    build_stamp: str = ""
    failure: Optional[WebappFailureSpec] = None
    attempts: list[AttemptCounter] = Field(default_factory=list)
    #: ``<compute_op typeid>/<call id>`` of the fixer agent running for this app — adopted, never doubled.
    agent_call: str = ""
    #: What setup still owes (a declared dependency not set up): shown on a running app.
    setup_owed: str = ""

    @property
    def showable(self) -> bool:
        return self.state in SHOWABLE

    def counter(self, fingerprint: str) -> AttemptCounter:
        return next((c for c in self.attempts if c.fingerprint == fingerprint), AttemptCounter(fingerprint=fingerprint))


class HandlingAction(StrEnum):
    #: The failure is noise: the app is usable.
    IGNORE = "ignore"
    #: Stop the app's processes and start them again.
    RESTART = "restart"
    #: Run a node of the setup tree (``arg``: its id, e.g. ``asset_setup:spora-app-tenant``) — a dependency.
    SETUP = "setup"
    #: Stop what Flowpad started on the app's declared ports, then start.
    FREE_PORTS = "free_ports"
    #: Forget the install stamp and install again.
    REINSTALL = "reinstall"
    #: Forget the build stamp and build again.
    REBUILD = "rebuild"
    #: Run ``setup/start_app.py <arg>``.
    RUN = "run"
    #: Hand it to the fixer agent with ``arg`` as its hint (still once per fingerprint per cooldown).
    ESCALATE = "escalate"
    #: Nothing automatic helps: say ``arg`` to the person.
    NEEDS_PERSON = "needs_person"


class WebappHandlingSpec(DataSpec):
    """One learned handling: a failure it matches, and what code does about it."""

    spec_kind: ClassVar[str] = "webapp.handling"
    model_config = ConfigDict(extra="forbid", frozen=True)

    id: str
    #: Matches this exact failure (``webapp.failure.fingerprint``). Either this or ``pattern``.
    fingerprint: str = ""
    #: A regex searched in the failure's NORMALIZED text.
    pattern: str = ""
    phase: Optional[FailurePhase] = None
    code: Optional[FailureCode] = None
    source: str = ""
    action: HandlingAction
    arg: str = ""
    learned_at: str = ""
    #: Times it ran and the re-check held / did not.
    fixed: int = 0
    not_fixed: int = 0
    note: str = ""


class WebappHandlingsFile(DataSpec):
    """``setup/webapp_handlings.json``."""

    spec_kind: ClassVar[str] = "webapp.handlings"
    model_config = ConfigDict(extra="forbid", frozen=True)

    version: int = 1
    handlings: list[WebappHandlingSpec] = Field(default_factory=list)


class WebappFixRequest(DataSpec):
    """What the fixer agent is handed when recovery reaches it: the app, the failure, what was tried."""

    spec_kind: ClassVar[str] = "webapp.fix_request"

    webapp_id: str
    app_name: str = ""
    project_id: str = ""
    #: The app's folder — where it, its ``setup/`` and its ``webapp.json`` are.
    folder: str = ""
    failure: WebappFailureSpec
    #: A learned handling's hint (ESCALATE) or what the person asked.
    hint: str = ""
    #: What recovery already tried for this failure, one line each.
    tried: list[str] = Field(default_factory=list)


__all__ = [
    "AGENT_COOLDOWN", "AttemptCounter", "BUSY", "FailureCode", "FailurePhase", "HandlingAction", "LifecycleState",
    "SHOWABLE", "WebappFailureSpec", "WebappFixRequest", "WebappHandlingSpec", "WebappHandlingsFile", "WebappLifecycleSpec",
]
