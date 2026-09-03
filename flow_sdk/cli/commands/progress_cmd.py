"""``flow progress ...`` — report progress from a shell, a script, or an agent.

Same sentence as the Python handle and the HTTP route: **address, then verb, then
argument**, behind a ``report`` subcommand::

    flow progress report index label "Indexing"
    flow progress report index total 5000
    flow progress report index/pdf inc-success
    flow progress report index/pdf inc-error "encrypted" --ref a.pdf
    flow progress report index done "indexed 5,000 · 17 orphans"

    flow progress list                  # what is running on this box
    flow progress show index            # one tree, as the UI sees it

The address sits behind ``report`` rather than directly after ``progress`` because a bare
``flow progress <path>`` cannot be told apart from a subcommand — an activity legitimately
called ``list`` or ``show`` would shadow one. Verb-first also matches ``flow record index``.

An agent running inside an AgenticProcess needs no ``--scope``: it defaults to that
process, read from ``FLOWPAD_EXECUTION_SCOPE`` the same way ``flow record`` resolves its
target, so an agent's progress lands on its own row in the footer chip.

For a tight loop, ``--stdin`` takes one ``verb arg`` per line, so walking ten thousand
files is one process rather than ten thousand::

    find . -name '*.md' | while read f; do
      echo "current $f"; echo inc-success
    done | flow progress report walk --stdin
"""

from __future__ import annotations

import sys
from typing import Any, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.activity import canonical_verb as _canonical_verb
from flow_sdk.cli.commands._common import (
    EXIT_CONNECTION_ERROR,
    EXIT_INVALID_ARG,
)
from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
)
from flow_sdk.cli.commands._common import (
    current_process_typeid as _current_process_typeid,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    local_get as _local_get,
)
from flow_sdk.cli.commands._common import (
    local_post as _local_post,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)

progress_app = typer.Typer(help="Report and read progress for long-running work.")

BASE = "/api/v1/activity"

#: How a verb reads its positional argument. Everything absent from here takes a value —
#: ``total 5000``, ``current a.md``. The message verbs read it as a sentence, because
#: ``done "indexed 5,000"`` is how a person says it; the bare ones take none at all.
_MESSAGE_VERBS = {"block", "pause", "done", "fail", "cancel", "message", "label", "inc_error"}
_BARE_VERBS = {"resume", "reset"}


def _url(path: str, *parts: str) -> str:
    from flow_sdk.cli.commands._common import discover_port

    port = discover_port()
    segments = [seg for seg in (path.strip("/"), *parts) if seg]
    # No trailing slash on the bare collection: the list route is ``/api/v1/activity``
    # exactly, and a trailing slash earns a redirect instead of an answer.
    return f"http://localhost:{port}{BASE}" + ("/" + "/".join(segments) if segments else "")


def _default_scope(explicit: "Optional[str]") -> "Optional[str]":
    """``--scope`` wins; otherwise the calling AgenticProcess, if there is one.

    An agent reporting its own progress should not have to know its own id, and a plain
    shell on the box should get the instance-wide default. Both fall out of this.
    """
    return explicit or _current_process_typeid()


def _scope_params(scope: "Optional[str]") -> "dict[str, Any]":
    """Query params for a read. An absent scope is OMITTED, not sent empty: a query string
    cannot carry ``None``, and ``scope=`` asks for an activity in a scope literally named
    "" — a different address from the instance-wide one, which always misses."""
    resolved = _default_scope(scope)
    return {"scope": resolved} if resolved else {}


def _body(verb: str, arg: "Optional[str]", *, ref, code, counter, n, scope) -> "dict[str, Any]":
    body: "dict[str, Any]" = {"n": n, "scope": scope, "ref": ref, "code": code, "counter": counter}
    if arg is not None and verb not in _BARE_VERBS:
        body["message" if verb in _MESSAGE_VERBS else "value"] = arg
    return {k: v for k, v in body.items() if v is not None}


def _request(method: str, url: str, **kwargs: Any) -> Any:
    """One round trip, with the two failure shapes both verbs and reads can hit.

    A refusal rides an HTTP 200 carrying an ``error_code`` (the convention
    ``routes/display.py`` spells out), so status alone does not say whether the call
    worked — both checks belong in one place rather than at each call site.
    """
    import requests

    send = _local_post if method == "POST" else _local_get
    try:
        resp = send(url, timeout=10, **kwargs)
    except requests.exceptions.RequestException as exc:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"cannot reach the backend: {exc}")

    payload = {}
    try:
        payload = resp.json()
    except ValueError:
        pass
    if resp.status_code != 200 or str(payload.get("status", "")).lower() == "fail":
        code = (payload.get("data") or {}).get("error_code", "PROGRESS_FAILED")
        _fail(EXIT_INVALID_ARG, code, payload.get("message") or _bad_response_message(resp))
    return payload.get("data")


def _post(path: str, verb: str, body: "dict[str, Any]") -> dict:
    return _request("POST", _url(path, verb), json=body) or {}


@progress_app.command("report", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def report(
    path: Annotated[str, typer.Argument(help="Activity address, e.g. 'index' or 'index/pdf'.")],
    verb: Annotated[Optional[str], typer.Argument(help="label|total|current|message|icon|inc-success|inc-skipped|inc-error|inc|block|resume|done|fail|cancel|reset|show")] = None,
    arg: Annotated[Optional[str], typer.Argument(help="The verb's argument.")] = None,
    n: Annotated[int, typer.Option("--n", help="Repeat count for the inc verbs.")] = 1,
    ref: Annotated[Optional[str], typer.Option("--ref", help="What an error is ABOUT — a path, a TypeId.")] = None,
    code: Annotated[Optional[str], typer.Option("--code", help="Machine-readable error code.")] = None,
    counter: Annotated[Optional[str], typer.Option("--counter", help="Counter name for 'inc'.")] = None,
    scope: Annotated[Optional[str], typer.Option("--scope", help="TypeId this activity belongs to. Defaults to the calling process.")] = None,
    read_stdin: Annotated[bool, typer.Option("--stdin", help="Read one 'verb arg' per line — one process for a whole loop.")] = False,
) -> None:
    """Apply one verb (or a stream of them) to the activity at ``path``."""
    resolved_scope = _default_scope(scope)

    if read_stdin:
        last: dict = {}
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            parts = line.split(" ", 1)
            stream_verb = _canonical_verb(parts[0])
            stream_arg = parts[1].strip() if len(parts) > 1 else None
            last = _post(path, stream_verb, _body(stream_verb, stream_arg, ref=ref, code=code, counter=counter, n=n, scope=resolved_scope))
        _ok({"activity": last})
        return

    if not verb:
        _fail(EXIT_INVALID_ARG, "NO_VERB", "a verb is required: flow progress report <path> <verb> [arg]")

    canonical = _canonical_verb(verb)
    _ok({"activity": _post(path, canonical, _body(canonical, arg, ref=ref, code=code, counter=counter, n=n, scope=resolved_scope))})


@progress_app.command("show")
def show(
    path: Annotated[str, typer.Argument(help="Activity address.")],
    scope: Annotated[Optional[str], typer.Option("--scope")] = None,
) -> None:
    """Print one activity tree — the same state the footer chip renders."""
    _ok({"activity": _request("GET", _url(path), params=_scope_params(scope))})


@progress_app.command("list")
def list_activities(
    scope: Annotated[Optional[str], typer.Option("--scope")] = None,
    all_scopes: Annotated[bool, typer.Option("--all", help="Every scope, not just this one.")] = False,
) -> None:
    """What is running on this box right now. Live work only — a finished root is gone."""
    params = {"all": "true"} if all_scopes else _scope_params(scope)
    _ok({"activities": _request("GET", _url(""), params=params) or []})


def main() -> None:  # pragma: no cover - entry point
    progress_app()


__all__ = ["progress_app"]
