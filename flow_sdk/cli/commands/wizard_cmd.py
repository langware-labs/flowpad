"""`flow wizard ...` — run a wizard, or close a conversational one.

    flow wizard run <name> [--approved]      — run it; exit its answer's exit_code
    flow wizard <agentic_process_id> close '{"status":"done","data":{}}'

``run`` exits exactly as ``flow op run`` does — the answer's own ``ExitCode``
(0 done, 1 not yet, 3 not applicable, 4 no such wizard, 7 refused), 2 when the
request itself failed, 5 when the server could not be reached. ``close`` posts
to the generic entity-event action; the AgenticProcess handler re-emits
``wizard.closed`` to resolve the frontend ``launchWizard`` promise.
"""

from __future__ import annotations

import json
import re
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
)
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)
from flow_sdk.cli.commands._common import (
    post_graph_json as _post_graph_json,
)
from flow_sdk.cli.commands._common import (
    get_graph_json as _get_graph_json,
)
from flow_sdk.schema.data_spec.compute_op_spec import AGENT_TIMEOUT

#: The request itself failed (a server error, a bad response) — never an
#: ExitCode. 7 used to be spent here, and 7 IS ExitCode.REFUSED: a script could
#: not tell "the server broke" from "not approved".
EXIT_REQUEST_FAILED = 2


# A value that opens like a Windows drive path. Deliberately does NOT require a
# separator after the colon: by the time we inspect a mangled value the
# separator is exactly what got eaten (``C:\temp`` arrives as ``C:<TAB>emp``).
_WIN_PATH = re.compile(r"^[A-Za-z]:")
# Control characters a JSON escape produces but a real path never contains —
# the fingerprint of ``C:\temp`` having been read as ``C:<TAB>emp``.
_MANGLED = re.compile(r"[\b\f\n\r\t\v]")


def _walk_strings(obj):
    if isinstance(obj, str):
        yield obj
    elif isinstance(obj, dict):
        for v in obj.values():
            yield from _walk_strings(v)
    elif isinstance(obj, list):
        for v in obj:
            yield from _walk_strings(v)


def _has_mangled_path(obj) -> bool:
    """True if some string looks like a Windows path carrying control chars."""
    return any(_WIN_PATH.match(s) and _MANGLED.search(s) for s in _walk_strings(obj))


def _loads_result(raw: str):
    """Parse a wizard result, tolerating raw Windows paths inside it.

    Agents build the close command by hand and routinely interpolate an
    absolute path (``"analysisPath": "C:\\Users\\…"``) without doubling the
    separators. That fails two different ways, and BOTH bite:

    * ``C:\\Users`` → ``\\U`` is not a valid JSON escape, so the parse errors
      out and the agent's whole result is lost.
    * ``C:\\temp\\refs`` → ``\\t`` and ``\\r`` ARE valid escapes, so it parses
      *silently* into ``C:<TAB>emp<CR>efs``. No error, just a path that points
      nowhere — which is worse, because nothing reports it.

    Repairing individual escapes cannot fix the second case, so we don't guess
    per-escape: when the payload is suspect we re-read it under the single
    coherent interpretation "every backslash in here is a literal path
    separator" and double them all. Wizard results carry paths and one-line
    summaries; none of them legitimately need ``\\n`` or ``\\t``.

    Strictly a fallback. Malformed JSON still raises the ORIGINAL error rather
    than being masked, and a payload that parses clean is returned untouched.
    """
    literalized = raw.replace("\\", "\\\\")
    try:
        result = json.loads(raw)
    except ValueError:
        # Invalid-escape case: the strict read failed outright.
        try:
            return json.loads(literalized)
        except ValueError:
            raise  # report the original failure, not the repair's
    # Silent-corruption case: it parsed, but a path came out with control
    # characters in it. Prefer the literal reading when that one is clean.
    if _has_mangled_path(result):
        try:
            repaired = json.loads(literalized)
        except ValueError:
            return result
        if not _has_mangled_path(repaired):
            return repaired
    return result


def _process_id(raw: str) -> str:
    value = raw.strip()
    return value.split("agentic_process-", 1)[1] if value.startswith("agentic_process-") else value


def _close_from_args(wizard_id: Optional[str], args: list[str]) -> None:
    if not wizard_id or len(args) < 2 or args[0] != "close":
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_WIZARD_COMMAND",
            "Usage: flow wizard <agentic_process_id> close '<json-result>'",
        )

    try:
        result = _loads_result(args[1])
    except ValueError as e:
        _fail(EXIT_INVALID_ARG, "INVALID_JSON", f"Wizard result must be JSON: {e}")
    if not isinstance(result, dict):
        _fail(EXIT_INVALID_ARG, "INVALID_JSON", "Wizard result must be a JSON object")

    status = result.get("status")
    if status not in {"done", "cancel", "error"}:
        _fail(EXIT_INVALID_ARG, "INVALID_STATUS", "Wizard result status must be done, cancel, or error")

    process_id = _process_id(wizard_id)
    payload = {**result, "wizardId": result.get("wizardId") or process_id}
    port = _discover_port()
    url = f"http://127.0.0.1:{port}/api/v1/graph/agentic_process/{process_id}/entity-event"

    def _on_error(status_code: int, body: dict):
        _fail(
            EXIT_REQUEST_FAILED if status_code != 0 else EXIT_CONNECTION_ERROR,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {status_code}"),
        )

    data = _post_graph_json(
        url,
        {"event": "wizard.close", "payload": payload},
        timeout=15,
        on_error=_on_error,
    )
    _ok({"process_id": process_id, "result": data.get("result") or data})


def _run_from_args(args: list[str]) -> None:
    """``flow wizard run <name> [--approved]`` — run it, exit its exit_code."""
    rest = [a for a in args if a != "--approved"]
    if not rest:
        _fail(EXIT_INVALID_ARG, "INVALID_WIZARD_COMMAND", "Usage: flow wizard run <name> [--approved]")
    name, approved = rest[0], "--approved" in args
    port = _discover_port()
    base = f"http://127.0.0.1:{port}/api/v1/graph/wizard"

    def _on_request_error(status_code: int, body: dict):
        _fail(
            EXIT_REQUEST_FAILED if status_code != 0 else EXIT_CONNECTION_ERROR,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("error") or f"HTTP {status_code}"),
        )

    listed = _get_graph_json(base, on_error=_on_request_error) or {}
    rows = listed.get("entities", listed) if isinstance(listed, dict) else listed
    row = next((r for r in (rows or []) if isinstance(r, dict) and r.get("name") == name), None)
    if row is None:
        # NOT_FOUND is an answer, so it exits as one (4), like `flow op run`.
        _fail(4, "WIZARD_NOT_FOUND", f"No wizard named {name!r}.")

    def _on_answer(status_code: int, body: dict):
        # 409 is the one status the edge spends — `busy` — and it still carries
        # the answer, so exit ITS code rather than calling the request failed.
        answer = body.get("data") if isinstance(body.get("data"), dict) else None
        if status_code == 409 and answer is not None:
            _ok({"wizard": name, "returned": answer})
            raise typer.Exit(int(answer.get("exit_code", 1)))
        _on_request_error(status_code, body)

    returned = _post_graph_json(
        f"{base}/{row['id']}/run", {"approved": approved},
        timeout=AGENT_TIMEOUT, on_error=_on_answer,
    )
    if not isinstance(returned, dict) or "exit_code" not in returned:
        # A 200 with no answer is a broken server, not a verdict.
        _fail(EXIT_REQUEST_FAILED, "NO_ANSWER", "The server returned no answer.")
    _ok({"wizard": name, "returned": returned})
    raise typer.Exit(int(returned["exit_code"]))


def wizard_command(
    ctx: typer.Context,
    wizard_id: Annotated[
        Optional[str],
        typer.Argument(help="Wizard AgenticProcess id or TypeId."),
    ] = None,
) -> None:
    """``flow wizard run <name>`` or ``flow wizard <agentic_process_id> close <json>``."""
    if wizard_id == "run":
        _run_from_args(list(ctx.args))
        return
    _close_from_args(wizard_id, list(ctx.args))
