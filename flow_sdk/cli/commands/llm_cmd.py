"""``flow llm ...`` — list the box's LLM sources and choose which one funds a harness.

A presenter, not a second implementation. Every action here is an operation the LLM Sources
screen already performs, reached through the SAME loopback action the UI calls
(``/api/v1/graph/compute_node/@local/llm-endpoint``). That is what keeps the CLI and the UI
from drifting: there is one resolver, one write, and one status shape, and this module only
renders them.

Transport follows the box, and only the transport: **HTTP when a backend is running**, because
``select_llm_source`` writes a ``Capability`` row and broadcasts it — from a separate process
that would mean SQLite writer contention and a notification the UI never receives — and
**in-process when none is**, because a pure-CLI install (``pip install``, ``flow auth login``,
``flow llm set``) never starts a server and there is then no writer to contend with and nobody
to notify. Both call the same functions in ``hub_endpoint_binding``.

Three scopes, one grammar::

    flow llm [scope] <action> [N] [all|<harness>]

``shell`` (the default, no prefix) persists nothing — it prints exports for the current
terminal. ``user`` is the box: the SAME write the picker's **Use** button makes, plus each
harness's own config file, because on a box whose only consumer is a person at a prompt the
selection alone would fund nothing. ``project`` pins rung 2, so every worker in that project
spends the named endpoint.

Error contract (parsed by agents — keep stable)::

    exit 0 — success
    exit 2 — invalid arguments (unknown row, unknown harness)
    exit 4 — nothing to act on (no sources, no project)
    exit 5 — connection error (server unreachable)
    exit 6 — the server refused the action (not logged in, unusable source)
"""

from __future__ import annotations

import functools
import json
import os
import shlex
from pathlib import Path
from typing import Any, NamedTuple, Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    backend_frames as _backend_frames,
)
from flow_sdk.cli.commands._common import (
    bad_response_message as _bad_response_message,
)
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
)
from flow_sdk.cli.commands._common import (
    fail as _fail,
)
from flow_sdk.cli.commands._common import (
    local_post as _local_post,
)
from flow_sdk.cli.commands._common import (
    local_request as _local_request,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)

EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_REFUSED = 6

llm_app = typer.Typer(
    name="llm",
    help="List the LLM sources this box can spend, and choose which one funds your harnesses.",
    add_completion=False,
)
user_app = typer.Typer(name="user", help="Apply the choice to this box (same as the UI's Use button).")
project_app = typer.Typer(name="project", help="Pin an endpoint for every worker in a project.")
llm_app.add_typer(user_app, name="user")
llm_app.add_typer(project_app, name="project")


# ── transport ────────────────────────────────────────────────────────────────


def _call(method: str, url: str, **kwargs: Any) -> dict:
    """One request against the local backend, unwrapped from the ``{status,data}`` envelope.

    Every failure mode ends in ``_fail`` so a caller never has to check twice.
    """
    try:
        resp = _local_request(method, url, timeout=30, **kwargs)
    except requests.exceptions.RequestException as exc:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {exc}")
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
    # ``SUCCESS`` exactly, matching ``_common.post_graph_json`` -- accepting a missing status
    # would have let the two transports judge the same body differently.
    if resp.status_code != 200 or str(body.get("status", "")).upper() != "SUCCESS":
        # The backend's own sentence, verbatim — it is the same text the picker renders, and
        # rewriting it here would make the CLI a second author of "why not".
        _fail(EXIT_REFUSED, "REFUSED", str(body.get("message") or f"HTTP {resp.status_code}"))
    return body.get("data") or {}


#: The five operations, each as ``(HTTP method, sub-path)``. Both transports end at the SAME
#: function — the route is a shim over it — so the fallback below is a change of transport,
#: never a second implementation.
_OPS: dict[str, tuple[str, str]] = {
    "status": ("GET", ""),
    "binding": ("POST", "/binding"),
    "select": ("POST", "/select"),
    "test": ("POST", "/test"),
    # The PER-ROW check, dispatched on the source kind -- so a device login is asked the
    # question that can actually fail for it. ``test`` above is the hub-only pass-through.
    "test_source": ("POST", "/test-source"),
    "unbind": ("DELETE", ""),
}


@functools.lru_cache(maxsize=1)
def _backend_port() -> int | None:
    """The running instance's port, or ``None`` when nothing is running.

    Cached: it is a ``server.json`` read, it cannot change inside one CLI invocation, and
    ``flow llm user set N all`` asks six times.
    """
    return _discover_port(required=False)


def _in_process(op: str, payload: dict) -> dict:
    """Run *op* here, for a box with no backend running.

    A pure-CLI install — ``pip install``, ``flow auth login``, ``flow llm set`` — never starts a
    server, and requiring one would make funding a bare ``claude`` impossible on exactly the box
    that needs it most. The HTTP path exists to avoid SQLite writer contention with a RUNNING
    backend and to let its broadcast reach the UI; with no backend there is no writer to contend
    with and nothing to notify, so the reason for the hop is gone. Same functions either way.
    """
    import asyncio

    from flow_sdk.builtin.agentic_process.cli_drivers import hub_endpoint_binding as binding

    calls = {
        "status": lambda: binding.hub_llm_endpoint_status(payload.get("project_id", "")),
        "unbind": binding.unbind_hub_llm_endpoint,
        "binding": lambda: binding.llm_binding(payload),
        "select": lambda: binding.select_llm_source(payload),
        "test": lambda: binding.test_hub_llm_endpoint(payload),
        "test_source": lambda: binding.check_llm_source(payload),
    }

    try:
        return asyncio.run(calls[op]()) or {}
    except binding.HubEndpointBindError as exc:
        # The backend's own sentence, exactly as the HTTP path relays it.
        _fail(EXIT_REFUSED, "REFUSED", str(exc))


def _op(op: str, payload: dict | None = None) -> dict:
    """One llm-endpoint operation, over HTTP when a backend is up and in-process when not."""
    payload = {k: v for k, v in (payload or {}).items() if v not in (None, "")}
    port = _backend_port()
    if port is None:
        return _in_process(op, payload)
    method, sub_path = _OPS[op]
    url = f"http://127.0.0.1:{port}/api/v1/graph/compute_node/@local/llm-endpoint{sub_path}"
    if method == "GET":
        return _call(method, url, params=payload or None)
    if method == "POST":
        return _call(method, url, json=payload)
    return _call(method, url)


def _status(project_id: str = "") -> dict:
    return _op("status", {"project_id": project_id})


# ── the list ─────────────────────────────────────────────────────────────────


class Row(NamedTuple):
    """One source, as the numbered list shows it. ``n`` is 1-based."""

    n: int
    typeid: str
    name: str
    kind: str  # the spelling `select` speaks: device | api_key | endpoint
    provider: str
    harnesses: list[str]  # worker names that offer this source
    scope: str  # process | project | user | default — where the winner came from
    active_for: list[str]  # worker names whose resolved source IS this row


def _worker_of(capability_kind: str) -> str:
    """``harness.claude.cli`` → ``claude``. The status dict is keyed by capability kind; the user
    thinks in worker names, and so does every other argument in this CLI.

    Looked up in the vendor table rather than split on dots: ``worker_capability_kind`` reads
    from ``VENDORS`` precisely because interpolating the kind "once produced a kind nothing
    registers", and string surgery on the way back reintroduces that.
    """
    from flow_sdk.flowpad_types.vendors import vendor_by

    vendor = vendor_by("capability_kind", capability_kind)
    return vendor.key if vendor is not None else capability_kind


def _select_kind(endpoint_kind: str) -> str:
    """``LLMEndpointKind`` → the spelling ``select_llm_source`` expects. Only ``hub`` differs;
    it is ``endpoint`` there, for the same reason ``selectKindFor`` exists in the frontend."""
    return "endpoint" if endpoint_kind == "hub" else endpoint_kind


def _rows(status: dict) -> list[Row]:
    """The status dict as one combined, numbered table.

    Deduplicated by ``endpoint_typeid`` — safe because every source IS an endpoint now, so a
    per-harness device login is its own row rather than a collision. Ordered by the resolver's
    own ``rank``, so the numbering matches the order the picker shows.

    **The numbering is scope-independent, and must stay that way.** It is built from
    ``sources``, which is the un-overlaid OFFER list — a project pin changes ``resolved`` and
    ``blocked``, never the offers. That is what lets ``list`` ask the project's question while
    ``use`` asks the box's and still agree on what "2" means. Number from anything the overlay
    touches and the two would disagree the moment a project pinned an endpoint.
    """
    endpoints = status.get("endpoints") or {}
    resolved = status.get("resolved") or {}
    merged: dict[str, dict] = {}

    for capability_kind, sources in (status.get("sources") or {}).items():
        worker = _worker_of(capability_kind)
        for source in sources or []:
            typeid = str(source.get("endpoint_typeid") or "")
            if not typeid:
                continue
            row = merged.setdefault(
                typeid,
                {"name": source.get("name") or typeid, "rank": source.get("rank", 0), "harnesses": [], "active": []},
            )
            row["harnesses"].append(worker)
            row["rank"] = min(row["rank"], source.get("rank", 0))

    # ``active`` comes from ``resolved`` — the overlay's winner — never from ``source.auto``.
    # A source may be auto-eligible for a harness that resolves to something else entirely.
    scopes: dict[str, str] = {}
    for capability_kind, pick in resolved.items():
        if not pick:
            continue
        typeid = str(pick.get("endpoint_typeid") or "")
        if typeid in merged:
            merged[typeid]["active"].append(_worker_of(capability_kind))
            scopes[typeid] = str(pick.get("origin") or "")

    ordered = sorted(merged.items(), key=lambda kv: (kv[1]["rank"], kv[1]["name"]))
    rows: list[Row] = []
    for n, (typeid, row) in enumerate(ordered, start=1):
        endpoint = endpoints.get(typeid) or {}
        rows.append(
            Row(
                n=n,
                typeid=typeid,
                name=str(row["name"]),
                kind=_select_kind(str(endpoint.get("kind") or "")),
                provider=str(endpoint.get("provider") or ""),
                harnesses=sorted(set(row["harnesses"])),
                scope=scopes.get(typeid, ""),
                active_for=sorted(set(row["active"])),
            )
        )
    return rows


def _all_harnesses(rows: list[Row]) -> list[str]:
    return sorted({worker for row in rows for worker in row.harnesses})


def _render(rows: list[Row]) -> None:
    if not rows:
        typer.echo("No LLM sources. Sign in to a harness, add a key, or log in to the hub.")
        return
    every = _all_harnesses(rows)
    width = max(len(row.name) for row in rows)
    typer.echo(f"  {'#':<3}{'SOURCE':<{width + 2}}{'KIND':<10}{'SCOPE':<10}HARNESSES")
    for row in rows:
        harnesses = "all" if row.harnesses == every else ",".join(row.harnesses)
        line = f"  {row.n:<3}{row.name:<{width + 2}}{row.kind or '-':<10}{row.scope or '-':<10}{harnesses}"
        if row.active_for:
            where = "all" if row.active_for == every else ",".join(row.active_for)
            line += f"   <- active ({where})"
        typer.echo(line)


def _pick(rows: list[Row], ref: str) -> Row:
    """The row a user named: a list number, an endpoint id, or a unique name prefix.

    The number is positional against a fresh read, so it can move if the inventory changes
    between calls. The id and the name prefix are the stable way to say the same thing.
    """
    ref = ref.strip()
    if ref.isdigit():
        n = int(ref)
        if not 1 <= n <= len(rows):
            _fail(EXIT_INVALID_ARG, "NO_SUCH_ROW", f"No source {n}. `flow llm list` shows 1-{len(rows)}.")
        return rows[n - 1]
    exact = [row for row in rows if row.typeid == ref or row.typeid.endswith(f"-{ref}")]
    if len(exact) == 1:
        return exact[0]
    prefixed = [row for row in rows if row.name.lower().startswith(ref.lower())]
    if len(prefixed) == 1:
        return prefixed[0]
    if not prefixed:
        _fail(EXIT_INVALID_ARG, "NO_SUCH_ROW", f"No source matches {ref!r}. Try `flow llm list`.")
    names = ", ".join(row.name for row in prefixed)
    _fail(EXIT_INVALID_ARG, "AMBIGUOUS", f"{ref!r} matches several sources: {names}")


def _targets(row: Row, harness: str, rows: list[Row]) -> list[str]:
    """The workers a write applies to. ``all`` means every harness that OFFERS this source —
    not every harness on the box, which would fail on the ones that cannot use it."""
    if harness in {"all", ""}:
        return row.harnesses
    if harness not in _all_harnesses(rows):
        _fail(EXIT_INVALID_ARG, "NO_SUCH_HARNESS", f"Unknown harness {harness!r}.")
    if harness not in row.harnesses:
        _fail(EXIT_INVALID_ARG, "NOT_OFFERED", f"{row.name} is not a source for {harness}.")
    return [harness]


# ── shell scope: render, never persist ───────────────────────────────────────


def _shell_dir(worker: str) -> Path:
    """Where a harness's generated config lives. Under the instance dir, because the binding
    is per-instance: two instances may spend different endpoints and must not share a file."""
    from flow_sdk.instance_settings import get_instance_settings

    return Path(get_instance_settings().instance_dir) / "llm" / worker


def _emit_exports(binding: dict, workers: list[str]) -> None:
    """Print what a shell must evaluate. Writes any generated config file first.

    codex and opencode cannot be redirected by a base-URL variable at all — their only
    env-reachable knob points AT a file — so for those two the export is a pointer and the
    real configuration is on disk.
    """
    for worker in workers:
        entry = (binding.get("harnesses") or {}).get(worker) or {}
        if entry.get("device"):
            typer.echo(f"# {worker}: signed in directly, nothing to export")
            continue
        if entry.get("reason"):
            typer.echo(f"# {worker}: {entry['reason']}")
            continue
        files = entry.get("files") or {}
        if files:
            # One directory per harness, written before the pointer that names it. The pointer
            # is emitted once, not once per file -- it addresses the directory or the single
            # file, never a set.
            directory = _shell_dir(worker)
            directory.mkdir(parents=True, exist_ok=True)
            for name, text in files.items():
                (directory / name).write_text(text)
            pointer = entry.get("pointer_env") or ""
            if pointer:
                target = directory if entry.get("pointer_is_dir") else directory / next(iter(files))
                typer.echo(f"export {pointer}={shlex.quote(str(target))}")
        for name, value in (entry.get("env") or {}).items():
            typer.echo(f"export {name}={shlex.quote(str(value))}")


# ── user scope: write where each harness looks by default ────────────────────


def _deep_merge(base: dict, fragment: dict) -> None:
    """*fragment* laid over *base*, recursing into dicts. Anything the user put there that we
    do not name survives — this writes into ``~/.claude/settings.json``, which is a file people
    hand-edit, and eating their settings would be far worse than not funding a harness."""
    for key, value in fragment.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value


def _prune(base: dict, fragment: dict) -> None:
    """Remove exactly the LEAVES *fragment* set, and any container it leaves empty.

    Not ``base.pop(key)`` for each top-level key: ``settings.json`` keeps the user's own
    variables in the same ``env`` block we write into, and dropping the block would take those
    with it. Clearing must give back the file as if we had never written.
    """
    for key, value in fragment.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _prune(base[key], value)
            if not base[key]:
                base.pop(key, None)
        else:
            base.pop(key, None)


def _profile_name() -> str:
    """The startup file the user's shell actually reads.

    ``~/.profile`` is the POSIX answer and the wrong one on a default macOS box: a non-login zsh
    reads ``~/.zshrc`` and never sources ``.profile``, so writing there would report success and
    fund nothing. The harness declares that it is profile-configured; which file that means is a
    fact about this machine, so it is resolved by the side that owns the filesystem.
    """
    shell = Path(os.environ.get("SHELL", "")).name
    return {"zsh": ".zshrc", "bash": ".bashrc"}.get(shell, ".profile")


def _write_user_config(worker: str, spec: dict, *, remove: bool = False) -> str:
    """Apply one harness's box-wide config. Returns a line to print, or ``""``."""
    fmt, rel = spec.get("fmt") or "", spec.get("path") or ""
    if not fmt or not rel:
        return f"  {worker}: {spec.get('note') or 'nothing to write'}"
    if rel == ".profile":
        rel = _profile_name()
    path = Path.home() / rel
    path.parent.mkdir(parents=True, exist_ok=True)

    if fmt == "json":
        try:
            current = json.loads(path.read_text()) if path.exists() else {}
        except ValueError:
            current = {}
        if remove:
            _prune(current, spec.get("merge") or {})
        else:
            _deep_merge(current, spec.get("merge") or {})
        path.write_text(json.dumps(current, indent=2) + "\n")
    else:
        from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import apply_managed_block

        existing = path.read_text() if path.exists() else ""
        path.write_text(apply_managed_block(existing, [] if remove else list(spec.get("lines") or [])))

    verb = "cleared" if remove else "wrote"
    note = f"  ({spec['note']})" if spec.get("note") else ""
    return f"  {worker}: {verb} ~/{rel}{note}"


# ── commands ─────────────────────────────────────────────────────────────────


@llm_app.callback(invoke_without_command=True)
def _default(ctx: typer.Context) -> None:
    """`flow llm` with no action lists the sources."""
    if ctx.invoked_subcommand is None:
        _list_sources(json_output=False)


@llm_app.command("list", help="Show every LLM source this box can spend, numbered.")
def _list_sources(
    json_output: Annotated[bool, typer.Option("--json", help="Emit the rows as JSON.")] = False,
) -> None:
    # Project-scoped, when there is one: a project pin outranks the box, and a list that
    # asked the box-wide question would show the wrong winner and an empty SCOPE column --
    # the exact blind spot ``LLMScope`` was introduced to close for the UI picker.
    rows = _rows(_status(_project_for_cwd(required=False)))
    if json_output:
        _ok({"sources": [row._asdict() for row in rows]})
        return
    _render(rows)


@llm_app.command("use", help='Print exports that fund THIS SHELL from a source. Use with: eval "$(flow llm use 2)"')
def _use_shell(
    ref: Annotated[str, typer.Argument(help="Row number from `flow llm list`, an endpoint id, or a name prefix.")],
    harness: Annotated[str, typer.Argument(help="all (default) or one of claude/codex/copilot/opencode.")] = "all",
    json_output: Annotated[bool, typer.Option("--json", help="With `auto`: emit the source as JSON.")] = False,
    no_browser: Annotated[
        bool, typer.Option("--no-browser", help="With `auto`: never open the chooser; exit 4 with its URL.")
    ] = False,
) -> None:
    # `flow llm set auto` is the spelling people reach for, and `set` is an alias of this, so
    # the word arrives HERE as a row reference. It names a question rather than a row, so it is
    # answered by `auto` rather than looked up -- see that command for why.
    if _is_auto(ref):
        _report(_resolve_or_choose(no_browser=no_browser), json_output=json_output)
        return
    _refuse_auto_flags(json_output=json_output, no_browser=no_browser)
    rows = _rows(_status())
    row = _pick(rows, ref)
    workers = _targets(row, harness, rows)
    # Ask for exactly the harnesses being funded -- the route takes a ``harness`` filter, and
    # requesting "all" only to drop most of it client-side materializes credentials nobody asked
    # for.
    binding = _op("binding", {"endpoint_typeid": row.typeid, "harness": harness})
    _emit_exports(binding, workers)


@llm_app.command("clear", help="Print unsets that undo `flow llm use` in this shell.")
def _clear_shell() -> None:
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import managed_env_vars

    # Derived from the harness specs, so no server and no network: asking the status for it
    # bought a hub refresh and four inventory reads to learn a constant.
    for name in managed_env_vars():
        typer.echo(f"unset {name}")


@llm_app.command("test", help="Spend one live call through a source and report the verdict.")
def _test(
    ref: Annotated[str, typer.Argument(help="Row number, endpoint id, or name prefix.")],
) -> None:
    row = _pick(_rows(_status()), ref)
    verdict = _op("test", {"endpoint_typeid": row.typeid})
    _ok({"source": row.name, **verdict})


@user_app.command("use", help="Make a source this box's default — identical to the picker's Use button.")
def _use_box(
    ref: Annotated[str, typer.Argument(help="Row number, endpoint id, or name prefix.")],
    harness: Annotated[str, typer.Argument(help="all (default) or one harness.")] = "all",
    no_browser: Annotated[
        bool, typer.Option("--no-browser", help="With `auto`: never open the chooser; exit 4 with its URL.")
    ] = False,
) -> None:
    # `flow llm user set auto`: make sure the box HAS a source (opening the chooser if it has
    # none), then apply that source box-wide -- the same write the picker's Use button makes.
    # Falls through into the normal path with a concrete row, so there is one writer either way.
    if _is_auto(ref):
        ref = _resolve_or_choose(no_browser=no_browser).typeid
    else:
        _refuse_auto_flags(no_browser=no_browser)
    rows = _rows(_status())
    row = _pick(rows, ref)
    workers = _targets(row, harness, rows)
    for worker in workers:
        payload = {"harness": worker, "kind": row.kind, "scope": "user", "endpoint_typeid": row.typeid}
        if row.kind == "api_key":
            payload["provider"] = row.provider
        _op("select", payload)
        typer.echo(f"  {worker} -> {row.name}")
    # ...and write it where each harness looks by DEFAULT, so a bare `claude` / `codex` /
    # `opencode` in any terminal is funded too. The selection above is what OUR workers read;
    # on a box whose only consumer is a person at a prompt it would otherwise fund nothing.
    binding = _op("binding", {"endpoint_typeid": row.typeid, "harness": harness})
    for worker in workers:
        spec = ((binding.get("harnesses") or {}).get(worker) or {}).get("user") or {}
        typer.echo(_write_user_config(worker, spec))


@user_app.command("clear", help="Drop this box's endpoint binding.")
def _clear_box() -> None:
    # Read what we wrote BEFORE dropping the binding — the specs are derived from the bound
    # endpoint, so afterwards there is nothing left to say which leaves were ours.
    bound = str(_status().get("endpoint_typeid") or "")
    specs = (_op("binding", {"endpoint_typeid": bound}).get("harnesses") or {}) if bound else {}

    data = _op("unbind")
    typer.echo("binding dropped" if data.get("was_bound") else "no binding was set")
    # Take the box-wide config back out too, or a bare CLI keeps spending an endpoint the box no
    # longer claims. Only our managed region / our own leaves are removed.
    for worker, entry in specs.items():
        spec = (entry or {}).get("user") or {}
        if spec.get("path"):
            typer.echo(_write_user_config(worker, spec, remove=True))


@project_app.command("use", help="Pin an endpoint for every worker in a project.")
def _use_project(
    ref: Annotated[str, typer.Argument(help="Row number, endpoint id, or name prefix.")],
    project: Annotated[Optional[str], typer.Option("--project", "-p", help="Project id. Default: the cwd's.")] = None,
) -> None:
    project_id = project or _project_for_cwd()
    row = _pick(_rows(_status(project_id)), ref)
    _op("select", {"scope": "project", "project_id": project_id, "endpoint_typeid": row.typeid, "kind": row.kind})
    typer.echo(f"  project {project_id} -> {row.name}")


@project_app.command("clear", help="Unpin a project, so the box-wide order applies again.")
def _clear_project(
    project: Annotated[Optional[str], typer.Option("--project", "-p", help="Project id. Default: the cwd's.")] = None,
) -> None:
    project_id = project or _project_for_cwd()
    _op("select", {"scope": "project", "project_id": project_id})
    typer.echo(f"  project {project_id} unpinned")


# ``set`` is the same verb under the spelling people reach for first. Registered as an alias
# rather than a second implementation so the two can never drift, and kept on every scope so
# `flow llm set` / `flow llm user set` / `flow llm project set` all read the way they sound.
llm_app.command("set", help='Alias of `use`. Fund THIS SHELL: eval "$(flow llm set 2)"')(_use_shell)
user_app.command("set", help="Alias of `use`.")(_use_box)
project_app.command("set", help="Alias of `use`.")(_use_project)


def _project_for_cwd(*, required: bool = True) -> str:
    """The project whose mount contains the working directory.

    Longest mount wins, so a project nested inside another resolves to the inner one. There is
    no ambient "current project" on the server — that lives in the client — so this is
    resolved here rather than guessed there.

    ``required=False`` for the listing, which is merely BETTER inside a project and must
    still work outside one.
    """
    cwd = Path.cwd().resolve()
    port = _backend_port()
    if port is None:
        # Project scope is the one scope that needs the graph. Say so plainly rather than
        # answering "no project mounts here", which would send the user hunting for the
        # wrong thing. The listing still works without one -- hence ``required``.
        if required:
            _fail(
                EXIT_NOT_FOUND, "NO_INSTANCE", "Project scope needs a running instance. Start one, or pass --project."
            )
        return ""
    rows = _call("GET", f"http://127.0.0.1:{port}/api/v1/graph/project", params={"limit": 500})
    best_mount, best_id = "", ""
    for row in rows if isinstance(rows, list) else []:
        mount = str(row.get("fs_storage_mount_path") or "")
        if not mount:
            continue
        try:
            resolved = Path(mount).resolve()
        except OSError:
            continue
        if (cwd == resolved or resolved in cwd.parents) and len(str(resolved)) > len(best_mount):
            best_mount, best_id = str(resolved), str(row.get("id") or "")
    if not best_id and required:
        _fail(EXIT_NOT_FOUND, "NO_PROJECT", f"No project mounts {cwd}. Pass --project <id>.")
    return best_id


# ── auto: "can this box issue an LLM call yet, and if not, let me fix it" ─────
#
# The one command that answers a question rather than performing an action. Everything else
# here assumes you already HAVE sources and are choosing between them; `auto` is what a fresh
# box, a fresh agent or a fresh CI runner asks before it can assume anything at all.
#
# Two halves, and only the second one needs a browser:
#
#   1. Is a source already resolved? That is a pure read of the SAME resolver every spawn uses
#      (`_status` -> `resolved`), and it works with no server running at all -- `_in_process`
#      exists for exactly this shape of install. A box that is already funded never opens a
#      window.
#   2. If not, hand the user the chooser and wait. The chooser is a screen, so it needs
#      something serving the UI -- but NOT a separately running instance: `flow auth login`
#      already establishes that the CLI can host the app itself for the length of one command,
#      and this does the same.
#
# **There is no poll and no timeout here, deliberately.** The obvious spelling of "wait until
# the user signs in" is a sleep loop with a budget, and a budget is exactly what this repo
# forbids -- it would also be wrong on the merits, since the thing being waited for is a human
# and no number is the right one. Instead the command holds a WebSocket open and blocks on it.
# Every way the chooser can succeed already broadcasts a frame:
#
#   * the Flowpad tile (hub login)        -> `cloud_login_status_msg`  (cli/auth/cloud_login.py)
#   * a harness OAuth grant / stored key  -> `llm_config_msg`          (app/actions/desktop_oauth.py)
#   * the picker's own Use write          -> `llm_config_msg`          (select_llm_source)
#
# The frame is only the WAKE-UP; it is never the answer. Each one re-asks the resolver, because
# "a credential changed" and "the box can now fund a call" are different claims and only the
# resolver is entitled to make the second one.


#: Frames that mean "this box's LLM funding may have changed".
#:
#: Deliberately NOT `data_op_msg`: an entity notification fires for changes all over the graph,
#: and each spurious wake costs a `_status` read -- a capability read, a key listing, a secret
#: store walk and a keychain round-trip PER harness. Two precise frames beat one broad one.
_FUNDING_FRAMES = frozenset({"llm_config_msg", "cloud_login_status_msg"})

#: Where the chooser lives. `ViewType.LLM_SETUP` in `flow_sdk/core/dock_address.py`.
_CHOOSER_PATH = "/dock/llm-setup"


def _is_evidence(pick: dict) -> bool:
    """Whether a resolver verdict is EVIDENCE the box can actually issue a call.

    One line, because the rule is not ours: the backend publishes ``unverified`` on every
    verdict (``Candidate.unverified``), which is where it belongs -- it needs the endpoint's
    kind, and a rule re-derived here would drift from the copy the setup screen makes. This
    used to be that second copy.

    **Absent means UNVERIFIED.** The flag is missing when the backend answering is older than
    this CLI -- and that is not a rare, historical box. A server loads its code once at start
    and keeps it: upgrade the package without restarting the desktop app (or an instance that
    has been up for days) and the new CLI talks to the old server until something restarts it.
    That window is normal, and it is the moment right after every update.

    Reading the silence as "verified" is the expensive way to be wrong. Observed: a box with
    codex NOT INSTALLED AT ALL was told `codex device login funds codex`, because the backend
    predated the flag by 23 minutes and the absence read as a yes. The user learns the truth
    when a call fails. Reading it as "unverified" is the cheap way to be wrong: the chooser
    opens when it did not strictly need to, and every source on it still works.

    So this fails safe, and deliberately does NOT keep a compatibility path for the older
    shape -- the repo does not carry back-compat shims, and a shim whose failure mode is a
    confident false claim is the worst kind to carry.
    """
    return pick.get("unverified") is False


def _probe_unproven_device_logins(status: dict) -> dict:
    """Ask every un-probed device login whether it is REALLY signed in, and re-read.

    Without this, requiring evidence (:func:`_is_evidence`) is too strict on the transport that
    needs it most. A device login only becomes ``CACHED`` once something has probed it, and the
    thing that normally does is the running backend -- so with **no backend at all**, which is
    the pure-CLI install this command is largely for, nothing has ever asked and every device
    login is ``PRESUMED`` forever. `auto` would then send a perfectly well-configured box to
    the chooser every single time.

    So rather than assume in either direction, ask. A vendor ``auth-status`` is a subprocess
    against credentials the user already pays for and makes no network call -- the same reason
    `useProbeDeviceLogins` runs it unasked whenever the LLM Sources page opens.

    Only reached when the box already looks unfunded, so the common path pays nothing: a box
    with evidence never gets here, and a box without it is about to open a BROWSER, next to
    which a few local subprocesses are free.

    A probe that refuses is not fatal -- "this CLI is not installed" is a perfectly good answer
    and the most likely one here. ``_op`` reports refusals by exiting, which is right for a
    user-invoked action and wrong for a question we asked on our own initiative.
    """
    from flow_sdk.builtin.llm_endpoint import LLMEndpointKind  # noqa: PLC0415

    asked = False
    for capability_kind, sources in (status.get("sources") or {}).items():
        # ``unverified`` is exactly "an un-probed device login" -- the backend's own verdict,
        # the same one `_is_evidence` reads. Re-deriving it from kind + authority here was the
        # third copy of one rule.
        if not any(source.get("unverified") for source in sources or []):
            continue
        try:
            _op("test_source", {"kind": LLMEndpointKind.DEVICE, "harness": _worker_of(capability_kind)})
        except Exception:  # noqa: BLE001 -- an unanswerable probe IS an answer ("not installed")
            pass
        asked = True
    return _status(_project_for_cwd(required=False)) if asked else status


def _auto_source(status: dict) -> Row | None:
    """The source that would fund a call right now, or ``None`` when nothing would.

    Read off the resolver's ``resolved`` -- the overlay's winner. NOT from ``source.auto``:
    that means "would win if nothing were chosen", which is true of several rows at once and
    false of the one actually in force whenever a preference or a project pin has spoken.
    `auto` promises the source a spawn would really get, so it reads what a spawn reads.

    ...but a winner is not automatically EVIDENCE -- see :func:`_is_evidence`. The resolver is
    right to fall back on an unproven device login (something must be tried, and there is
    nothing better), and this command is right to refuse to call that "you are set up": one
    picks the best of what exists, the other decides whether anything exists at all.

    The default vendor wins ties. Any funded row is a truthful answer to "is this box funded",
    but a person at a prompt is usually about to run THEIR harness, and naming a source that
    funds a different one reads as a wrong answer even though it is a correct one.
    """
    from flow_sdk.flowpad_types.vendors import default_vendor

    trusted = {
        str(pick.get("endpoint_typeid") or "")
        for pick in (status.get("resolved") or {}).values()
        if pick and _is_evidence(pick)
    }
    funded = [row for row in _rows(status) if row.active_for and row.typeid in trusted]
    if not funded:
        return None
    preferred = default_vendor().key
    return next((row for row in funded if preferred in row.active_for), funded[0])


def _report(row: Row, *, json_output: bool) -> None:
    """The command's whole output: which source, of what kind, funding what."""
    if json_output:
        _ok({"source": row._asdict()})
        return
    detail = "/".join(part for part in (row.kind, row.provider) if part) or "-"
    typer.echo(f"  {row.name}  ({detail})  funds {','.join(row.active_for)}")


def _chooser_url(port: int) -> str:
    """The chooser's address, carrying the cookie-gate secret when the instance is armed.

    The browser's FIRST contact is necessarily cookie-less, and the gate exempts no path --
    so on a gated instance a bare URL would open onto a 403 page instead of the chooser. The
    query transport exists for precisely this case; `gate_headers` tells us whether there is
    anything to carry.
    """
    from flow_sdk.instance_settings.cookie_gate import get_cookie_gate, is_gated

    url = f"http://127.0.0.1:{port}{_CHOOSER_PATH}"
    return f"{url}?cookie-gate={get_cookie_gate()}" if is_gated() else url


def _serve_chooser_here() -> int:
    """Run the app in THIS process, and return the port it came up on.

    `flow auth login` established the pattern: a pure-CLI install has no backend, and requiring
    one would make funding a bare `claude` impossible on exactly the box that needs it most.
    The UI is baked into the wheel (`build_ui.py` -> `server/static/assets/`), so the hosted app
    serves the chooser like any other screen.

    Readiness comes from the app's OWN lifespan hook, not from a sleep. `wait_for_login_callback`
    guesses with `time.sleep(1)`, which is both a race and a delay; `server.on_startup` fires
    when the app is actually up. The hooks list is captured by reference in `_build_lifespan`,
    so registering after `create()` still works.
    """
    import threading

    import uvicorn

    from flow_sdk.instance_settings import get_instance_settings
    from flow_sdk.server.app import app, server

    ready = threading.Event()
    failure: list[BaseException] = []

    async def _mark_ready() -> None:
        ready.set()

    server.on_startup(_mark_ready)
    port = get_instance_settings().port
    config = uvicorn.Config(app, host="127.0.0.1", port=port, log_level="warning")

    def _run() -> None:
        try:
            uvicorn.Server(config).run()
        except BaseException as exc:  # noqa: BLE001 — reported below, on the caller's thread
            failure.append(exc)
        finally:
            # Unblock either way. A thread that died on a bind error must not leave the CLI
            # waiting on an event nobody will ever set.
            ready.set()

    threading.Thread(target=_run, daemon=True).start()
    ready.wait()
    if failure:
        _fail(
            EXIT_CONNECTION_ERROR,
            "CONNECTION_ERROR",
            f"Could not serve the LLM chooser on port {port}: {failure[0]}",
        )
    # `_op` routes over HTTP as soon as a port exists, and the cached answer predates this
    # server. Both transports end at the same functions, but the HTTP one is now the correct
    # choice: there IS a live writer, and the browser wants its broadcasts.
    _backend_port.cache_clear()
    return port


def _steer_open_app(port: int) -> bool:
    """Send the ALREADY-OPEN app to the chooser. True when it went somewhere.

    A second window is the wrong answer when the app is already in front of the user: they end
    up with two Flowpads, and the one they were looking at is not the one being asked the
    question. The backend already knows whether a tab is listening -- that is what
    ``flow navigate view`` is -- so ask it first and only spawn a browser when nobody is home.

    ``navigate/view`` HIJACKS the tab the user is looking at, which `navigate_cmd` reserves for
    an explicit "take me there". This IS that: the user just typed a command whose entire
    purpose is to be taken to the chooser.

    Never fatal. Every failure -- no tab (``NO_ACTIVE_TAB``), an older server with no such
    route, a refusal -- means the same thing to this caller: nobody is listening, open a
    browser. ``_op``/``_call`` answer refusals by EXITING, which is right for a user-invoked
    action and wrong for a question we asked on our own initiative.
    """
    try:
        resp = _local_post(
            f"http://127.0.0.1:{port}/api/v1/agent/navigate/view",
            json={"view": _CHOOSER_PATH.rsplit("/", 1)[-1]},
            timeout=5,
        )
        if resp.status_code == 200 and (resp.json() or {}).get("ok"):
            typer.echo("Opened the LLM setup in Flowpad.", err=True)
            return True
    except Exception:  # noqa: BLE001 -- any failure means "nobody is listening"
        pass
    return False


async def _await_funding(port: int, url: str) -> Row | None:
    """Open the chooser and block until the resolver can name a source.

    The socket work is ``_common.backend_frames`` — a general "wait for the backend to say
    something" primitive, not this command's own plumbing. What is specific to `auto` is only
    WHICH frames to wake on and what question to re-ask on each wake.

    Returns ``None`` only when the socket closes without the box ever becoming funded, i.e. the
    server went away. A user who closes the window without choosing anything leaves this
    blocked, which is correct: nothing has happened yet, and Ctrl-C is how a person says they
    changed their mind. There is no budget to expire here, on purpose.
    """
    import asyncio
    import webbrowser

    async def _open_browser() -> None:
        # Runs once the socket is UP (see ``backend_frames``), so a user who signs in instantly
        # cannot beat us to the frame.
        if not await asyncio.to_thread(_steer_open_app, port):
            # The return value is load-bearing on a headless box -- over SSH, in CI, on a server
            # with no display, `webbrowser.open` finds no handler and answers False without
            # raising. Ignoring it printed "Opened <url>" over a window that does not exist and
            # then blocked on a socket nobody would ever satisfy: a lie followed by a hang, the
            # one shape a CLI must not have. Waiting is still right (the URL is reachable
            # through a forwarded port, and Ctrl-C is always there) -- but it has to say what
            # really happened.
            opened = await asyncio.to_thread(webbrowser.open, url)
            typer.echo(
                f"Opened {url}" if opened else f"No browser on this machine. Open this to continue:\n  {url}",
                err=True,
            )
        typer.echo("Waiting for you to choose a source… (Ctrl-C to cancel)", err=True)

    async for _frame in _backend_frames(port, _FUNDING_FRAMES, on_connected=_open_browser):
        # A credential changed. Whether the BOX can now fund a call is the resolver's question,
        # not this frame's -- a failed login broadcasts too.
        row = _auto_source(await asyncio.to_thread(_status))
        if row is not None:
            return row
    return None


def _refuse_auto_flags(*, json_output: bool = False, no_browser: bool = False) -> None:
    """Refuse `auto`-only flags on a row reference, rather than ignoring them.

    ``set`` and ``use`` take a POSITIONAL row and dispatch on the word ``auto``, so these
    options have to be declared on the whole command even though only that one branch reads
    them. Accepting and silently dropping them is the failure mode to avoid: a caller who
    writes ``flow llm set 2 --json`` and gets shell exports has been told nothing went wrong.
    """
    given = [flag for flag, on in (("--json", json_output), ("--no-browser", no_browser)) if on]
    if given:
        _fail(
            EXIT_INVALID_ARG,
            "INVALID_ARG",
            f"{' and '.join(given)} apply to `auto` only.",
            {"remediation": ["Use `flow llm set auto " + " ".join(given) + "`"]},
        )


def _is_auto(ref: str) -> bool:
    """Whether a row reference is really the `auto` question.

    Checked before `_pick`, never inside it: `_pick` resolves names by unique PREFIX, so a
    source someone named "Auto top-up" would otherwise answer to this word, and the box would
    silently pick a row when it was asked a question. A reserved word is matched exactly.
    """
    return ref.strip().lower() == "auto"


def _resolve_or_choose(*, no_browser: bool = False) -> Row:
    """The source that funds LLM calls — obtaining one, via the chooser, if the box has none.

    The whole of `auto`, minus the reporting, so the user scope can reuse the answer instead of
    running the command for its side effect and then asking again.
    """
    # Project-scoped when there is one, for the same reason `list` is: a project pin outranks
    # the box, so the box-wide question would report a source a spawn here would not get.
    status = _status(_project_for_cwd(required=False))
    row = _auto_source(status)
    if row is None:
        # Nothing has EVIDENCE yet -- but on a box with no backend nothing has ever been asked,
        # so ask before sending the user to a browser.
        row = _auto_source(_probe_unproven_device_logins(status))
    if row is not None:
        return row

    port = _backend_port()
    if no_browser:
        # The URL is the actionable part -- an agent that cannot open a window can still hand
        # it to the person who can. Only meaningful when something is serving it.
        where = _chooser_url(port) if port is not None else _CHOOSER_PATH
        _fail(
            EXIT_NOT_FOUND,
            "NO_LLM_SOURCE",
            "This box has no LLM source and --no-browser was given.",
            {"remediation": [f"Open {where} and choose one", "Or re-run without --no-browser"]},
        )

    if port is None:
        port = _serve_chooser_here()
    import asyncio

    row = asyncio.run(_await_funding(port, _chooser_url(port)))
    if row is None:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", "Lost the connection to Flowpad before a source was chosen.")
    return row


@llm_app.command(
    "auto",
    help="Report the source that funds LLM calls, opening the chooser when the box has none.",
)
def _auto(
    json_output: Annotated[bool, typer.Option("--json", help="Emit the source as JSON.")] = False,
    no_browser: Annotated[
        bool, typer.Option("--no-browser", help="Never open the chooser; exit 4 with its URL instead.")
    ] = False,
) -> None:
    _report(_resolve_or_choose(no_browser=no_browser), json_output=json_output)
