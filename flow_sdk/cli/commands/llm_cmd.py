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

import json
import os
import shlex
from pathlib import Path
from typing import Any, NamedTuple, Optional

import requests
import typer
from typing_extensions import Annotated

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
    "unbind": ("DELETE", ""),
}


def _backend_port() -> int | None:
    """The running instance's port, or ``None`` when nothing is running."""
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
    lines: list[str] = []
    for worker in workers:
        entry = (binding.get("harnesses") or {}).get(worker) or {}
        if entry.get("device"):
            lines.append(f"# {worker}: signed in directly, nothing to export")
            continue
        if entry.get("reason"):
            lines.append(f"# {worker}: {entry['reason']}")
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
                lines.append(f"export {pointer}={shlex.quote(str(target))}")
        for name, value in (entry.get("env") or {}).items():
            lines.append(f"export {name}={shlex.quote(str(value))}")
    for line in lines:
        typer.echo(line)


# ── user scope: write where each harness looks by default ────────────────────


def _deep_merge(base: dict, fragment: dict) -> dict:
    """*fragment* laid over *base*, recursing into dicts. Anything the user put there that we
    do not name survives — this writes into ``~/.claude/settings.json``, which is a file people
    hand-edit, and eating their settings would be far worse than not funding a harness."""
    for key, value in fragment.items():
        if isinstance(value, dict) and isinstance(base.get(key), dict):
            _deep_merge(base[key], value)
        else:
            base[key] = value
    return base


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
        elif key in base:
            base.pop(key, None)


def _managed_block(existing: str, lines: list[str]) -> str:
    """*existing* with our managed region replaced by *lines* (removed when empty).

    Same reason as the merge above: a ``config.toml`` or a ``.profile`` belongs to the user, and
    only the region between the markers is ours to rewrite.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers.api_auth import MANAGED_BEGIN, MANAGED_END

    kept, skipping = [], False
    for line in existing.splitlines():
        if line.strip() == MANAGED_BEGIN:
            skipping = True
        elif line.strip() == MANAGED_END:
            skipping = False
        elif not skipping:
            kept.append(line)
    while kept and not kept[-1].strip():
        kept.pop()
    if lines:
        kept += [MANAGED_BEGIN, *lines, MANAGED_END]
    return "\n".join(kept) + ("\n" if kept else "")


def _write_user_config(worker: str, spec: dict, *, remove: bool = False) -> str:
    """Apply one harness's box-wide config. Returns a line to print, or ``""``."""
    fmt, rel = spec.get("fmt") or "", spec.get("path") or ""
    if not fmt or not rel:
        return f"  {worker}: {spec.get('note') or 'nothing to write'}"
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
        existing = path.read_text() if path.exists() else ""
        path.write_text(_managed_block(existing, [] if remove else list(spec.get("lines") or [])))

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
) -> None:
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
    for name in _status().get("managed_vars") or []:
        typer.echo(f"unset {name}")


@llm_app.command("test", help="Spend one live call through a source and report the verdict.")
def _test(
    ref: Annotated[str, typer.Argument(help="Row number, endpoint id, or name prefix.")],
) -> None:
    row = _pick(_rows(_status()), ref)
    if row.kind != "endpoint":
        _fail(EXIT_INVALID_ARG, "NOT_TESTABLE", f"{row.name} is not a hub endpoint, so there is nothing to test.")
    verdict = _op("test", {"endpoint_typeid": row.typeid})
    _ok({"source": row.name, **verdict})


@user_app.command("use", help="Make a source this box's default — identical to the picker's Use button.")
def _use_box(
    ref: Annotated[str, typer.Argument(help="Row number, endpoint id, or name prefix.")],
    harness: Annotated[str, typer.Argument(help="all (default) or one harness.")] = "all",
) -> None:
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
    binding = _op("binding", {"endpoint_typeid": row.typeid, "harness": "all"})
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
    cwd = Path(os.getcwd()).resolve()
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
    best: tuple[int, str] = (0, "")
    for row in rows if isinstance(rows, list) else (rows.get("items") or []):
        mount = str(row.get("fs_storage_mount_path") or "")
        if not mount:
            continue
        try:
            resolved = Path(mount).resolve()
        except OSError:
            continue
        if cwd == resolved or resolved in cwd.parents:
            if len(str(resolved)) > best[0]:
                best = (len(str(resolved)), str(row.get("id") or ""))
    if not best[1] and required:
        _fail(EXIT_NOT_FOUND, "NO_PROJECT", f"No project mounts {cwd}. Pass --project <id>.")
    return best[1]
