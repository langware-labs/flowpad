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

An agent running inside an AgenticProcess needs no ``--subject``: it defaults to that
process, read from ``FLOWPAD_EXECUTION_SCOPE`` the same way ``flow record`` resolves its
target, so an agent's progress lands on its own row in the footer chip. Work the agent
ORCHESTRATES for the person watching goes to the whole box with ``--subject none``::

    flow progress report qa plan "p02:2=pytest API,p05:3=vitest API" --subject none
    flow progress report qa/p02 set-progress "done=1 skipped=0" --subject none

For a tight loop, ``--stdin`` takes one ``verb arg`` per line, so walking ten thousand
files is one process rather than ten thousand::

    find . -name '*.md' | while read f; do
      echo "current $f"; echo inc-success
    done | flow progress report walk --stdin
"""

from __future__ import annotations

import json
import shlex
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
_BARE_VERBS = {"resume", "reset", "rerun"}


def _url(path: str, *parts: str) -> str:
    from flow_sdk.cli.commands._common import discover_port

    port = discover_port()
    segments = [seg for seg in (path.strip("/"), *parts) if seg]
    # No trailing slash on the bare collection: the list route is ``/api/v1/activity``
    # exactly, and a trailing slash earns a redirect instead of an answer.
    return f"http://localhost:{port}{BASE}" + ("/" + "/".join(segments) if segments else "")


#: ``--subject none`` — report to the whole box even from inside an AgenticProcess.
#: Work an agent ORCHESTRATES (a QA cycle, a migration) belongs on the footer for the
#: person watching, not on the agent's own row, which the footer folds into the worker.
NO_SUBJECT = "none"


def _default_subject(explicit: "Optional[str]") -> "Optional[str]":
    """``--subject`` wins; otherwise the calling AgenticProcess, if there is one.

    An agent reporting its own progress should not have to know its own id, and a plain
    shell on the box should get the instance-wide default. Both fall out of this.
    ``--subject none`` is the explicit instance-wide address, process or not.
    """
    if explicit is not None and explicit.strip().lower() == NO_SUBJECT:
        return None
    return explicit or _current_process_typeid()


def _parse_plan(arg: str) -> "list[dict[str, Any]]":
    """``plan``'s argument: JSON, or ``name[:total][=label]`` items separated by commas.

    ``"p02:2=pytest API,p05:3=vitest API"`` — the compact form a shell line can carry.
    """
    text = arg.strip()
    if text.startswith("["):
        return json.loads(text)
    items: "list[dict[str, Any]]" = []
    for part in (p.strip() for p in text.split(",")):
        if not part:
            continue
        head, _, label = part.partition("=")
        name, _, total = head.partition(":")
        item: "dict[str, Any]" = {"name": name.strip()}
        if label.strip():
            item["label"] = label.strip()
        if total.strip():
            item["total"] = int(total)
        items.append(item)
    return items


def _parse_progress(arg: str) -> "dict[str, int]":
    """``set-progress``'s argument: JSON, or ``done=5 skipped=1 errors=0``."""
    text = arg.strip()
    if text.startswith("{"):
        return json.loads(text)
    out: "dict[str, int]" = {}
    for token in text.replace(",", " ").split():
        key, _, value = token.partition("=")
        out[key.strip()] = int(value)
    return out


#: Verbs whose argument is structured rather than one value or one sentence.
_PARSERS = {"plan": _parse_plan, "set_progress": _parse_progress}


def _subject_params(subject_entity: "Optional[str]") -> "dict[str, Any]":
    """Query params for a read. An absent subject entity is OMITTED, not sent empty: a query string
    cannot carry ``None``, and ``subject_entity=`` asks for an activity in a subject_entity literally named
    "" — a different address from the instance-wide one, which always misses."""
    resolved = _default_subject(subject_entity)
    return {"subject_entity": resolved} if resolved else {}


def _body(verb: str, arg: "Optional[str]", *, ref, code, counter, n, subject_entity) -> "dict[str, Any]":
    body: "dict[str, Any]" = {"n": n, "subject_entity": subject_entity, "ref": ref, "code": code, "counter": counter}
    if arg is not None and verb in _PARSERS:
        try:
            body["value"] = _PARSERS[verb](arg)
        except (ValueError, TypeError) as exc:
            _fail(EXIT_INVALID_ARG, "BAD_ARGUMENT", f"cannot read {verb} argument {arg!r}: {exc}")
    elif arg is not None and verb not in _BARE_VERBS:
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


#: Options a ``--stdin`` line may carry for itself, overriding the command line's.
_LINE_OPTIONS = {"--ref": "ref", "--code": "code", "--counter": "counter", "--n": "n"}


def _parse_stream_line(line: str) -> "tuple[str, Optional[str], dict[str, str]]":
    """One ``--stdin`` line: ``verb [arg ...] [--ref R] [--code C] [--counter K] [--n N]``.

    Shell-quoted, so a reporter can write ``inc-error 'AssertionError: 1 != 2' --ref
    tests/a.py::t`` and every failure carries its own ref. A line that is not valid shell
    quoting (an unpaired apostrophe in a file name) falls back to the plain
    ``verb rest-of-line`` form, which is what this read before options existed.
    """
    try:
        tokens = shlex.split(line)
    except ValueError:
        head, _, rest = line.partition(" ")
        return _canonical_verb(head), (rest.strip() or None), {}
    if not tokens:
        return "", None, {}
    opts: "dict[str, str]" = {}
    words: "list[str]" = []
    i = 1
    while i < len(tokens):
        key = _LINE_OPTIONS.get(tokens[i])
        if key is not None and i + 1 < len(tokens):
            opts[key] = tokens[i + 1]
            i += 2
            continue
        words.append(tokens[i])
        i += 1
    return _canonical_verb(tokens[0]), (" ".join(words) or None), opts


@progress_app.command("report", context_settings={"allow_extra_args": True, "ignore_unknown_options": True})
def report(
    path: Annotated[str, typer.Argument(help="Activity address, e.g. 'index' or 'index/pdf'.")],
    verb: Annotated[Optional[str], typer.Argument(help="label|total|current|message|icon|plan|inc-success|inc-skipped|inc-error|inc|set-counter|set-progress|block|pause|resume|rerun|done|fail|cancel|reset")] = None,
    arg: Annotated[Optional[str], typer.Argument(help="The verb's argument.")] = None,
    n: Annotated[int, typer.Option("--n", help="Repeat count for the inc verbs.")] = 1,
    ref: Annotated[Optional[str], typer.Option("--ref", help="What an error is ABOUT — a path, a TypeId.")] = None,
    code: Annotated[Optional[str], typer.Option("--code", help="Machine-readable error code.")] = None,
    counter: Annotated[Optional[str], typer.Option("--counter", help="Counter name for 'inc'.")] = None,
    subject_entity: Annotated[Optional[str], # `--scope` stays as an alias: agents and prompts already written against it
        # keep working, and a rename that silently breaks a running worker is not a
        # rename, it is a regression.
        typer.Option("--subject", "--scope", help="TypeId this activity belongs to, or 'none' for the whole box. Defaults to the calling process.")] = None,
    read_stdin: Annotated[bool, typer.Option("--stdin", help="Read one shell-quoted 'verb arg [--ref R] [--counter K] [--n N]' per line — one process for a whole loop.")] = False,
) -> None:
    """Apply one verb (or a stream of them) to the activity at ``path``."""
    resolved_subject = _default_subject(subject_entity)

    if read_stdin:
        last: dict = {}
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            stream_verb, stream_arg, opts = _parse_stream_line(line)
            last = _post(path, stream_verb, _body(
                stream_verb, stream_arg,
                ref=opts.get("ref", ref), code=opts.get("code", code),
                counter=opts.get("counter", counter), n=int(opts.get("n", n)),
                subject_entity=resolved_subject,
            ))
        _ok({"activity": last})
        return

    if not verb:
        _fail(EXIT_INVALID_ARG, "NO_VERB", "a verb is required: flow progress report <path> <verb> [arg]")

    canonical = _canonical_verb(verb)
    _ok({"activity": _post(path, canonical, _body(canonical, arg, ref=ref, code=code, counter=counter, n=n, subject_entity=resolved_subject))})


@progress_app.command("show")
def show(
    path: Annotated[str, typer.Argument(help="Activity address.")],
    subject_entity: Annotated[Optional[str], typer.Option("--subject", "--scope")] = None,
) -> None:
    """Print one activity tree — the same state the footer chip renders."""
    _ok({"activity": _request("GET", _url(path), params=_subject_params(subject_entity))})


@progress_app.command("list")
def list_activities(
    subject_entity: Annotated[Optional[str], typer.Option("--subject", "--scope")] = None,
    all_subjects: Annotated[bool, typer.Option("--all", help="Every subject entity, not just this one.")] = False,
) -> None:
    """What is running on this box right now. Live work only — a finished root is gone."""
    params = {"all": "true"} if all_subjects else _subject_params(subject_entity)
    _ok({"activities": _request("GET", _url(""), params=params) or []})


def main() -> None:  # pragma: no cover - entry point
    progress_app()


__all__ = ["progress_app"]
