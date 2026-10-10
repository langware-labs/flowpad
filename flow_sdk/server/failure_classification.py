"""Classification of a backend death: deterministic and fatal, or possibly transient.

The monitor (``flow_sdk.server.launch``) restarts a backend that died. That is the
right reflex for a crash with an unknown cause and the wrong one for a cause that
cannot change by itself: Windows application control refusing an unsigned
extension module, an interpreter the policy will not run, a critical native
component that is missing or built for another architecture. Restarting those
reproduces the failure, fills the log with identical tracebacks and -- in the
field case, FLOWPAD-2231 -- left the desktop app waiting 146 s for a backend
that had died three times in the meantime.

This module is the ONE place that decides. It is pure: text in, verdict out, so
the monitor, the CLI and the tests share the rules. The desktop app reads the
record the monitor writes (``server-failure.json``, see :func:`to_record`) and
shows the same reason -- the two never classify independently when the record
exists.

Narrow on purpose. Only the exact shapes below are fatal; an ImportError of an
optional dependency, a non-zero exit with no recognised cause, or a health
check that failed while the backend is still booting are NOT fatal here.
"""

from __future__ import annotations

import hashlib
import platform
import re
import sys
from dataclasses import dataclass, field
from typing import Iterable, Mapping

SCHEMA_VERSION = 1

# ---------------------------------------------------------------------------
# Kinds
# ---------------------------------------------------------------------------

#: Windows application control (Smart App Control, App Control for Business /
#: WDAC, Device Guard) refused a file the backend loads. The field case.
POLICY_BLOCKED = "policy-blocked"
#: The interpreter itself could not be started (CreateProcess refused by policy,
#: or the executable is for another architecture).
INTERPRETER_BLOCKED = "interpreter-blocked"
#: A critical native runtime component is missing or cannot be loaded.
NATIVE_MISSING = "native-missing"
#: A binary built for a different architecture than this Windows / Python.
UNSUPPORTED_ARCH = "unsupported-arch"
#: The runtime failed its own integrity / signature verification (the desktop
#: app's repair reports this kind; the monitor never produces it).
RUNTIME_INTEGRITY = "runtime-integrity"
#: The backend died the same way too many times in a row without ever becoming
#: healthy: deterministic by repetition even when no single line names a cause.
CRASH_LOOP = "crash-loop"
#: Nothing recognised: a crash with an unknown cause, a transient condition.
UNKNOWN = "unknown"

FATAL_KINDS = frozenset(
    {POLICY_BLOCKED, INTERPRETER_BLOCKED, NATIVE_MISSING, UNSUPPORTED_ARCH, RUNTIME_INTEGRITY, CRASH_LOOP}
)

#: The kinds the desktop app's runtime repair can address: it replaces the
#: interpreter and reinstalls the engine on it.
REPAIRABLE_KINDS = frozenset({POLICY_BLOCKED, INTERPRETER_BLOCKED, NATIVE_MISSING, UNSUPPORTED_ARCH, RUNTIME_INTEGRITY})

#: Extension modules that ship WITH the interpreter (CPython's own DLLs/ directory).
#: A policy block on one of these is fixed by replacing the interpreter with a signed
#: build; a block on a third-party wheel's module (pydantic_core's _pydantic_core,
#: cryptography's _rust) is not -- the repair reinstalls the same wheel bytes.
INTERPRETER_MODULES = frozenset(
    {
        "_multiprocessing",
        "_ssl",
        "_socket",
        "_sqlite3",
        "_ctypes",
        "_asyncio",
        "_overlapped",
        "_hashlib",
        "_bz2",
        "_lzma",
        "_decimal",
        "_uuid",
        "select",
        "_queue",
        "pyexpat",
        "unicodedata",
        "_elementtree",
        "_json",
        "_zoneinfo",
        "_wmi",
        "winsound",
        "_msi",
        "_tkinter",
        "_testcapi",
        "_ctypes_test",
    }
)


def is_interpreter_module(module: str | None) -> bool:
    """True for a module the interpreter itself ships (see INTERPRETER_MODULES)."""
    if not module:
        return False
    return module.split(".")[-1] in INTERPRETER_MODULES or module in INTERPRETER_MODULES


# ---------------------------------------------------------------------------
# What the OS says
# ---------------------------------------------------------------------------

# Code Integrity's wording ("An Application Control policy has blocked this
# file"), the shell's ("blocked by group policy", "Device Guard"), and the Win32
# error that carries it: 4551 ERROR_SYSTEM_INTEGRITY_POLICY_VIOLATION, which
# Python renders as "os error 4551" (uv) or "[WinError 4551]". 1260 is
# ERROR_ACCESS_DISABLED_BY_POLICY (software restriction / AppLocker).
POLICY_BLOCK_RE = re.compile(
    r"An Application Control policy has blocked this file"
    r"|Device Guard"
    r"|blocked by (?:your organization|group policy|an administrator|your administrator)"
    r"|\bos error 4551\b"
    r"|\[WinError (?:4551|1260)\]",
    re.IGNORECASE,
)

# "ImportError: DLL load failed while importing _multiprocessing: <OS text>"
DLL_IMPORT_RE = re.compile(r"ImportError: DLL load failed while importing ([A-Za-z0-9_.]+): (.*)$")

# The OS texts a DLL load can fail with, besides the policy ones above.
MODULE_NOT_FOUND_RE = re.compile(
    r"specified module could not be found|specified procedure could not be found", re.IGNORECASE
)
BAD_IMAGE_RE = re.compile(
    r"not a valid Win32 application|%1 is not a valid|\[WinError 193\]|Bad EXE format", re.IGNORECASE
)

# Native extension modules the engine cannot boot without. A missing OPTIONAL
# module (a plugin's accelerator, a test-only helper) must not be fatal, so the
# "could not be found" shape is fatal only for a module in this set.
CRITICAL_NATIVE_MODULES = frozenset(
    {
        "_multiprocessing",
        "_ssl",
        "_socket",
        "_sqlite3",
        "_ctypes",
        "_asyncio",
        "_overlapped",
        "_hashlib",
        "_bz2",
        "_lzma",
        "_decimal",
        "_uuid",
        "select",
        "pydantic_core._pydantic_core",
        "_pydantic_core",
        "cryptography.hazmat.bindings._rust",
        "_rust",
    }
)

# Win32 error codes a spawn (CreateProcess) fails with when policy refuses the
# executable, and when the executable is for another architecture.
SPAWN_POLICY_ERRNOS = frozenset({4551, 1260})
SPAWN_BAD_IMAGE_ERRNOS = frozenset({193, 216})  # ERROR_BAD_EXE_FORMAT, ERROR_EXE_MACHINE_TYPE_MISMATCH

# Windows Code Integrity event ids. 3077 is the one that means a file WAS
# refused; 3076 is the audit-mode "would have been refused" and 3033 the
# audit-mode signing-level note. Only 3077 is evidence of an enforced block.
CI_ENFORCED_BLOCK_EVENT_IDS = frozenset({3077})
CI_AUDIT_EVENT_IDS = frozenset({3076, 3033})


# ---------------------------------------------------------------------------
# Verdict
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class FailureVerdict:
    """What a backend death means. ``fatal`` is the whole decision for the monitor."""

    kind: str
    fatal: bool
    reason: str
    module: str | None = None
    excerpt: str | None = None
    traceback: str | None = None
    source: str = "server-log"  # 'server-log' | 'spawn' | 'repetition'
    exit_code: int | None = None
    evidence: dict = field(default_factory=dict)

    @property
    def repairable(self) -> bool:
        """Whether replacing the interpreter (the desktop app's runtime repair) can fix this.

        A policy block names the module; one that belongs to a third-party wheel is NOT
        fixed by a new interpreter (the field case of 2026-10-10: ``_pydantic_core`` from
        a two-day-old pydantic-core release with no reputation yet)."""
        if self.kind not in REPAIRABLE_KINDS:
            return False
        if self.kind == POLICY_BLOCKED and self.module and not is_interpreter_module(self.module):
            return False
        return True

    def to_record(
        self,
        *,
        fingerprint: Mapping[str, str],
        at: str,
        attempts: int,
        server_log: str | None,
        monitor_pid: int | None,
        engine_version: str | None,
    ) -> dict:
        """The on-disk shape the desktop app reads (``server-failure.json``).

        Every key here is read by ``electron/fatal-failure.js``; the two sides
        are tested against the same sample (test 15: the monitor and Electron
        agree on the fatal reason)."""
        return {
            "schema": SCHEMA_VERSION,
            "kind": self.kind,
            "fatal": self.fatal,
            "repairable": self.repairable,
            "reason": self.reason,
            "module": self.module,
            "excerpt": self.excerpt,
            "traceback": self.traceback,
            "source": self.source,
            "exit_code": self.exit_code,
            "evidence": dict(self.evidence),
            "attempts": attempts,
            "restarts_stopped": self.fatal,
            "fingerprint": dict(fingerprint),
            "engine_version": engine_version,
            "server_log": server_log,
            "at": at,
            "monitor_pid": monitor_pid,
        }


def transient(reason: str = "no recognised fatal cause", *, exit_code: int | None = None) -> FailureVerdict:
    return FailureVerdict(kind=UNKNOWN, fatal=False, reason=reason, exit_code=exit_code, source="server-log")


# ---------------------------------------------------------------------------
# Classification from the server log
# ---------------------------------------------------------------------------


def _traceback_block(lines: list[str], index: int) -> tuple[str, str | None]:
    """The traceback that ends at ``lines[index]`` (from the last ``Traceback`` header,
    at most 400 lines back) and the last ``File "..."`` frame in it."""
    start = index
    file_frame: str | None = None
    for j in range(index - 1, max(-1, index - 400), -1):
        line = lines[j]
        m = re.match(r'^\s*File "([^"]+)"', line)
        if m and file_frame is None:
            file_frame = m.group(1)
        if line.startswith("Traceback (most recent call last)"):
            start = j
            break
        if file_frame is None:
            start = j
    return "\n".join(lines[start : index + 1]), file_frame


def classify_server_log(text: str | None, *, exit_code: int | None = None) -> FailureVerdict:
    """Decide from the tail of the server log whether the death was deterministic.

    Scans from the end: the LAST recognised line wins, so a transient line early
    in a long log does not shadow a fatal one near the death. ``exit_code`` is
    recorded, never decisive on its own: a non-zero exit with no recognised
    cause is transient.
    """
    # Rich (typer's pretty tracebacks in `flow start`) wraps long lines at 80 columns, splitting the
    # phrase we match on: re-join the two places that wrap inside it before scanning line by line.
    text = re.sub(r"(An Application)\s*\n\s*(Control policy)", r"\1 \2", text or "")
    text = re.sub(r"(while importing)\s*\n\s*([A-Za-z0-9_.]+:)", r"\1 \2", text)
    lines = text.splitlines()
    for i in range(len(lines) - 1, -1, -1):
        line = lines[i]
        dll = DLL_IMPORT_RE.search(line)
        if dll:
            module, os_text = dll.group(1), dll.group(2)
            tb, frame = _traceback_block(lines, i)
            evidence = {"file": frame} if frame else {}
            if POLICY_BLOCK_RE.search(os_text):
                return FailureVerdict(
                    kind=POLICY_BLOCKED,
                    fatal=True,
                    reason=(
                        f'Windows application control blocked the Python module "{module}" '
                        "(Smart App Control or an organization's application-control policy decides this per file). "
                        "Restarting the server cannot change that."
                    ),
                    module=module,
                    excerpt=line.strip(),
                    traceback=tb,
                    exit_code=exit_code,
                    evidence={**evidence, "enforced": True},
                )
            if BAD_IMAGE_RE.search(os_text) and module in CRITICAL_NATIVE_MODULES:
                return FailureVerdict(
                    kind=UNSUPPORTED_ARCH,
                    fatal=True,
                    reason=f'The Python module "{module}" is built for a different architecture than this Windows/Python.',
                    module=module,
                    excerpt=line.strip(),
                    traceback=tb,
                    exit_code=exit_code,
                    evidence=evidence,
                )
            if MODULE_NOT_FOUND_RE.search(os_text) and module in CRITICAL_NATIVE_MODULES:
                return FailureVerdict(
                    kind=NATIVE_MISSING,
                    fatal=True,
                    reason=f'A critical native component of the Python runtime is missing or incompatible: "{module}" could not be loaded.',
                    module=module,
                    excerpt=line.strip(),
                    traceback=tb,
                    exit_code=exit_code,
                    evidence=evidence,
                )
            # A DLL load failure of a module we do not know to be critical: not ours to call fatal.
            continue
        if POLICY_BLOCK_RE.search(line) and not line.lstrip().startswith("#"):
            # The policy text outside an ImportError: a spawn refused inside the
            # server (a worker, a tool) is reported by the server, not fatal for it.
            # Only a refusal of the server's own process is -- and that one never
            # reaches this log because the process does not start. So: record the
            # line, stay non-fatal.
            return FailureVerdict(
                kind=UNKNOWN,
                fatal=False,
                reason="application-control text in the server log outside an ImportError (a child process?)",
                excerpt=line.strip(),
                exit_code=exit_code,
                evidence={"enforced": True},
            )
    return transient(exit_code=exit_code)


# ---------------------------------------------------------------------------
# Classification of a spawn failure (the interpreter itself)
# ---------------------------------------------------------------------------


def classify_spawn_error(exc: BaseException) -> FailureVerdict:
    """``Popen`` raised: the interpreter could not be started at all."""
    winerror = getattr(exc, "winerror", None)
    text = str(exc)
    if winerror in SPAWN_POLICY_ERRNOS or POLICY_BLOCK_RE.search(text):
        return FailureVerdict(
            kind=INTERPRETER_BLOCKED,
            fatal=True,
            reason="Windows application control refused to run the Python interpreter the FlowPad engine uses.",
            excerpt=text.strip(),
            source="spawn",
            evidence={"winerror": winerror, "enforced": True},
        )
    if winerror in SPAWN_BAD_IMAGE_ERRNOS or BAD_IMAGE_RE.search(text):
        return FailureVerdict(
            kind=UNSUPPORTED_ARCH,
            fatal=True,
            reason="The Python interpreter the FlowPad engine uses is built for a different architecture than this Windows.",
            excerpt=text.strip(),
            source="spawn",
            evidence={"winerror": winerror},
        )
    if isinstance(exc, FileNotFoundError):
        return FailureVerdict(
            kind=NATIVE_MISSING,
            fatal=True,
            reason="The Python interpreter the FlowPad engine uses is missing.",
            excerpt=text.strip(),
            source="spawn",
            evidence={"errno": getattr(exc, "errno", None)},
        )
    return FailureVerdict(
        kind=UNKNOWN, fatal=False, reason=f"spawn failed: {text.strip()}", excerpt=text.strip(), source="spawn"
    )


# ---------------------------------------------------------------------------
# Repetition
# ---------------------------------------------------------------------------

#: Consecutive deaths-before-healthy after which the monitor stops: a backend
#: that never came up five times running is not going to on the sixth.
CRASH_LOOP_LIMIT = 5


def crash_loop_verdict(deaths: int, last: FailureVerdict | None) -> FailureVerdict:
    excerpt = last.excerpt if last else None
    return FailureVerdict(
        kind=CRASH_LOOP,
        fatal=True,
        reason=(
            f"The FlowPad engine exited {deaths} times in a row without ever becoming healthy. "
            "Restarting it again would reproduce the same failure; the logs name the cause."
        ),
        excerpt=excerpt,
        traceback=last.traceback if last else None,
        exit_code=last.exit_code if last else None,
        source="repetition",
        evidence={"deaths": deaths},
    )


# ---------------------------------------------------------------------------
# Code Integrity events (Windows)
# ---------------------------------------------------------------------------


def classify_code_integrity_events(events: Iterable[Mapping]) -> dict:
    """Split Code Integrity events into enforced blocks and audit-only notes.

    ``events`` are mappings with at least ``id`` (int); ``file`` / ``process``
    are carried through when present. An audit-only event (3076 "would have
    blocked", 3033) is information, never a fatal classification by itself:
    audit mode blocks nothing, and the backend that logged an ImportError under
    an enforced policy is the only thing that proves enforcement.
    """
    enforced: list[dict] = []
    audit: list[dict] = []
    for ev in events:
        try:
            event_id = int(ev.get("id"))
        except (TypeError, ValueError):
            continue
        entry = {"id": event_id, "file": ev.get("file"), "process": ev.get("process")}
        if event_id in CI_ENFORCED_BLOCK_EVENT_IDS:
            enforced.append(entry)
        elif event_id in CI_AUDIT_EVENT_IDS:
            audit.append(entry)
    return {"enforced": enforced, "audit": audit, "enforced_block": bool(enforced)}


def is_enforced_block_event(event_id: int) -> bool:
    return int(event_id) in CI_ENFORCED_BLOCK_EVENT_IDS


# ---------------------------------------------------------------------------
# Fingerprint: "the same server under unchanged runtime conditions"
# ---------------------------------------------------------------------------


def runtime_fingerprint(*, python: str | None = None, engine_version: str | None = None) -> dict:
    """What has to change before the same failure is worth trying again: the
    interpreter (path -- the repair installs a different one), the engine
    version, the platform. A security-policy change is invisible here; that is
    what the user's explicit Retry is for."""
    py = python or sys.executable
    engine = engine_version or _engine_version()
    plat = f"{sys.platform}-{platform.machine().lower()}"
    digest = hashlib.sha256(f"{py}|{engine}|{plat}".encode("utf-8")).hexdigest()[:16]
    return {"hash": digest, "python": py, "engine_version": engine, "platform": plat}


def same_fingerprint(a: Mapping | None, b: Mapping | None) -> bool:
    if not a or not b:
        return False
    if a.get("hash") and b.get("hash"):
        return a["hash"] == b["hash"]
    return all(a.get(k) == b.get(k) for k in ("python", "engine_version", "platform"))


def _engine_version() -> str:
    try:
        from flow_sdk._version import __version__

        return __version__
    except Exception:  # noqa: BLE001 -- the fingerprint must never fail the monitor
        return "unknown"


__all__ = [
    "SCHEMA_VERSION",
    "POLICY_BLOCKED",
    "INTERPRETER_BLOCKED",
    "NATIVE_MISSING",
    "UNSUPPORTED_ARCH",
    "RUNTIME_INTEGRITY",
    "CRASH_LOOP",
    "UNKNOWN",
    "FATAL_KINDS",
    "REPAIRABLE_KINDS",
    "CRITICAL_NATIVE_MODULES",
    "CRASH_LOOP_LIMIT",
    "FailureVerdict",
    "classify_server_log",
    "classify_spawn_error",
    "classify_code_integrity_events",
    "is_enforced_block_event",
    "crash_loop_verdict",
    "runtime_fingerprint",
    "same_fingerprint",
    "transient",
]
