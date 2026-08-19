"""Call a folder module over a JSON contract.

A data source that ships its own implementation is a folder with an executable
in it. This is the one place that knows how to talk to such a module, so the
protocol is defined once rather than re-derived by every caller.

**The request travels as a FILE, not on stdin.** ``CommandExecutor`` has no
stdin — and that absence is load-bearing rather than an oversight: a remote node
can be handed an argv and a file, but not a pipe. Writing the request through
``executor.write_bytes`` and passing its path is therefore the only shape that
behaves identically on this machine and on a compute node. Singer's taps take
their config and state the same way, for the same reason.

**Failure is classified by exit code, not parsed from text.** A module that
cannot be fixed by trying again (bad credentials, malformed config) exits 3; a
module that might succeed later (a 5xx, a reset connection) exits 4. Anything
else is treated as transient, because guessing "permanent" on an exit code we
have not seen would silently stop a working source — the same rule
``ingest/health.py`` applies to exceptions.

**stderr is never parsed.** It is captured and attached to failures so an author
can debug, and ignored otherwise. Only stdout carries the contract.
"""
from __future__ import annotations

import json
from dataclasses import dataclass
from typing import TYPE_CHECKING, Any, Mapping, Optional, Sequence

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.utils.command_executor import CommandExecutor

#: The module's own exit contract. Only these two are meaningful; every other
#: non-zero code is transient by the rule above.
EXIT_OK = 0
EXIT_CONFIG = 3
EXIT_TRANSIENT = 4

#: Name of the request file written into the call's working directory. Fixed
#: rather than random: a module author debugging by hand wants a path they can
#: predict, and the directory is already per-call.
REQUEST_FILE = "request.json"


class ModuleFailure(Exception):
    """A classified failure from a module call.

    Carries ``kind`` rather than a subsystem's own enum so this module stays
    below ingest: the caller maps ``"config"`` / ``"transient"`` onto whatever
    health vocabulary it uses. ``logs`` is the module's stderr, attached because
    a subprocess that failed silently is the worst thing to debug.
    """

    def __init__(self, kind: str, message: str, *, logs: str = "", returncode: int = 0):
        super().__init__(message)
        self.kind = kind
        self.logs = logs
        self.returncode = returncode


@dataclass(frozen=True)
class ModuleResult:
    """What one verb call produced."""

    data: Any
    logs: str = ""


def _classify(returncode: int) -> str:
    return "config" if returncode == EXIT_CONFIG else "transient"


async def call_module(
    executor: "CommandExecutor",
    *,
    script: str,
    verb: str,
    request: Mapping[str, Any],
    workdir: str,
    env: Optional[Mapping[str, str]] = None,
    timeout: Optional[int] = None,
    argv_prefix: Sequence[str] = (),
) -> ModuleResult:
    """Run one verb and return its parsed response.

    ``workdir`` is supplied by the caller rather than invented here: it is the
    directory the request is written into and the module runs in, and only the
    caller knows whether that must exist on this machine or on a node.

    ``argv_prefix`` lets a caller run a module that is not directly executable
    (``["python3"]`` for a ``.py`` without an exec bit). Empty means the script
    is invoked on its own, which is the normal case.
    """
    request_path = f"{workdir.rstrip('/')}/{REQUEST_FILE}"
    await executor.make_dirs(workdir)
    await executor.write_bytes(request_path, json.dumps(dict(request)).encode("utf-8"))

    result = await executor.run(
        [*argv_prefix, script, verb, "--request", request_path],
        cwd=workdir,
        env=env,
        timeout=timeout,
    )

    if result.returncode != EXIT_OK:
        raise ModuleFailure(
            _classify(result.returncode),
            f"{verb} exited {result.returncode}",
            logs=result.stderr,
            returncode=result.returncode,
        )

    # A zero exit with unparseable stdout is a CONFIG failure, not transient:
    # the module ran to completion and produced something that is not the
    # contract, which retrying cannot fix.
    try:
        data = json.loads(result.stdout or "null")
    except json.JSONDecodeError as exc:
        raise ModuleFailure(
            "config",
            f"{verb} returned invalid JSON: {exc}",
            logs=result.stderr,
        ) from exc

    return ModuleResult(data=data, logs=result.stderr)
