"""Agent-facing app discovery/open commands."""

from __future__ import annotations

import os
import re
import subprocess
from pathlib import Path
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.app_discovery import WebAppCandidate, discover_webapps
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
    resolve_process_id as _resolve_process_id,
)
from flow_sdk.core.dev_server import start_detached as _start_detached
from flow_sdk.core.dev_server import wait_for_port as _wait_for_port

app_app = typer.Typer(
    name="app",
    help="Discover, register, start, and show local web apps.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_OK = 0
EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_START_FAILED = 6

_PROCESS_HELP = "Target AgenticProcess id (defaults to the calling process via FLOWPAD_EXECUTION_SCOPE)."


@app_app.command("discover", help="Scan the current checkout for likely web apps.")
def discover_app(
    query: Annotated[Optional[str], typer.Argument(help="Words to match against app names/paths.")] = None,
    root: Annotated[Optional[str], typer.Option("--root", help="Directory to scan (defaults to cwd).")] = None,
    max_depth: Annotated[int, typer.Option("--max-depth", help="Maximum directory depth to scan.")] = 6,
) -> None:
    scan_root = _resolve_root(root)
    candidates = discover_webapps(scan_root, query or "", max_depth=max_depth)
    _ok({"root": str(scan_root), "candidates": [candidate.to_dict() for candidate in candidates]})


@app_app.command("open", help="Find, start, register, and show the best matching web app.")
def open_app(
    query: Annotated[Optional[str], typer.Argument(help="Words like 'dashboard', 'admin', or empty for best app.")] = None,
    root: Annotated[Optional[str], typer.Option("--root", help="Directory to scan/start from (defaults to cwd).")] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
    port: Annotated[Optional[int], typer.Option("--port", help="Override the app port.")] = None,
    no_start: Annotated[bool, typer.Option("--no-start", help="Register/show only; do not launch a server.")] = False,
    dist: Annotated[Optional[str], typer.Option("--dist", help="Build-output dir (relative to the app) to serve as the app's delivery.")] = None,
    install: Annotated[bool, typer.Option("--install/--no-install", help="Install JS dependencies if node_modules is missing.")] = True,
    timeout: Annotated[float, typer.Option("--timeout", help="Seconds to wait for the port after starting.")] = 75.0,
    max_depth: Annotated[int, typer.Option("--max-depth", help="Maximum directory depth to scan.")] = 6,
) -> None:
    scan_root = _resolve_root(root)
    process_id = _resolve_process_id(process)
    request = query or ""
    placed = port is None and not no_start and (declared := _start_declared(request)) is not None
    if placed:
        # The project's own app: the backend started it (or found it) on its port, by the one rule.
        port, no_start = declared, True

    artifacts = _list_webapp_artifacts(process_id, request)
    artifact = _select_artifact(artifacts, request, scan_root)
    if artifact is not None:
        opened = _open_artifact(
            artifact,
            process_id=process_id,
            root=scan_root,
            port_override=port,
            no_start=no_start,
            timeout=timeout,
            placed=placed,
        )
        if opened is not None:
            _ok(opened)
            return

    candidates = discover_webapps(scan_root, request, max_depth=max_depth)
    if not candidates:
        _fail(EXIT_NOT_FOUND, "NO_WEBAPP", f"No web app found under {scan_root}")

    candidate = candidates[0]
    opened = _open_candidate(
        candidate,
        process_id=process_id,
        request=request,
        dist=dist,
        port_override=port,
        no_start=no_start,
        install=install,
        timeout=timeout,
        placed=placed,
    )
    _ok(opened)


@app_app.command("serve", help="Register an app's built output so Flowpad serves it, and show it.")
def serve_app(
    name: Annotated[Optional[str], typer.Argument(help="Display name for the app (defaults to the folder name).")] = None,
    root: Annotated[Optional[str], typer.Option("--root", help="The app directory (defaults to cwd).")] = None,
    dist: Annotated[Optional[str], typer.Option("--dist", help="Build output within the app to serve. Omit when the folder IS the output.")] = None,
    process: Annotated[Optional[str], typer.Option("--process", "-p", help=_PROCESS_HELP)] = None,
    no_show: Annotated[bool, typer.Option("--no-show", help="Register only; do not present it in the display.")] = False,
) -> None:
    """Serve the app from Flowpad's own origin — no dev server, no port.

    This is the mode an app wants when it talks to Flowpad: served from the
    backend's origin, it is handed the API origin and the session cookies ride
    along, so the SDK works with nothing to configure. Registering without a
    port is what makes the display resolve `served` instead of pointing at a dev
    server that isn't there.
    """
    app_dir = _resolve_root(root)
    process_id = _resolve_process_id(process)

    data = _register_webapp(
        process_id,
        {
            "name": (name or "").strip() or app_dir.name,
            "path": str(app_dir),
            "dist": dist,
            "description": f"Flowpad-served web app at {app_dir}",
            "show": not no_show,
        },
    )
    # What serves the build output: the placement's `static` endpoint.
    endpoint = next(
        (e for e in data.get("endpoints") or [] if (e.get("backend") or {}).get("type") == "static"), None
    )
    if endpoint is None:
        _fail(
            EXIT_NOT_FOUND,
            "NO_BUILD_OUTPUT",
            f"No servable output under {app_dir}. Build the app first, or pass --dist <dir>.",
        )
    _ok(
        {
            "source": "serve",
            "artifact": data.get("artifact"),
            "endpoint": endpoint,
            "shown": data.get("shown"),
            "serving": endpoint["backend"]["root"],
        }
    )


@app_app.command("free-dev-port", help="Print a free local port for a dev server (8000-8099, else OS-assigned).")
def free_dev_port(
    bare: Annotated[bool, typer.Option("--bare", help="Print only the number (for PORT=$(...)).")] = False,
) -> None:
    """The port picker `flow app open` uses for static apps, exposed on its own.

    Agents that start their own server (``python3 -m http.server``, a dev
    server) call this instead of choosing a number: same band, same probe, so
    a port this prints is one ``flow app open`` would have picked too. No
    lease is taken — the caller binds it next.
    """
    port = _choose_static_port()
    if bare:
        typer.echo(str(port))
        return
    _ok({"port": port, "in_range": _STATIC_PORT_RANGE.start <= port < _STATIC_PORT_RANGE.stop})


def _project_action_url(action: str, *, required: bool = True) -> str | None:
    """``project/<id>/<action>`` for the project the caller stands in; None outside any project —
    and, with ``required=False``, when no backend is running."""
    from flow_sdk.cli.commands._common import discover_port, graph_url, project_for_path  # noqa: PLC0415

    server_port = _discover_port() if required else discover_port(required=False)
    if not server_port:
        return None
    project_id = project_for_path(server_port, os.getcwd(), create=False)
    return graph_url(server_port, f"project/{project_id}/{action}") if project_id else None


def _project_action(action: str, body: dict | None = None) -> dict:
    """Call an action of the project the caller stands in: a GET, or a POST when there is a body."""
    from flow_sdk.cli.commands._common import get_graph_json  # noqa: PLC0415

    url = _project_action_url(action)
    if url is None:
        _fail(EXIT_NOT_FOUND, "NO_PROJECT", f"No Flowpad project contains {os.getcwd()}")

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        _fail(EXIT_NOT_FOUND if status_code == 404 else EXIT_CONNECTION_ERROR, "NOT_FOUND" if status_code == 404 else "SERVER_ERROR", message)

    if body is None:
        return get_graph_json(url, timeout=15, on_error=_on_error) or {}
    return _post_graph_json(url, body, timeout=90, on_error=_on_error) or {}


def _start_declared(request: str) -> int | None:
    """The port of the project app ``request`` names (or of its only app), brought up the one way —
    validate → load → setup → fix (``bring_up``, behind ``app-start``); None when the caller is in no
    project or no ``webapp.json`` app here matches. A load that does not come up is the answer: its
    reason, and the fixer's verdict on it."""
    if _project_action_url("app-start", required=False) is None:
        return None
    names = sorted({row["app"] for row in _project_action("app-ports").get("ports") or []})
    name = request if request in names else (names[0] if not request and len(names) == 1 else None)
    if name is None:
        return None
    load: dict = {"setup_available": True}
    # A failed load goes on to setup, once (``bring_up`` reads the failure); the setup-fixer is a step of it.
    while load.get("state") != "ready" and load.get("setup_available"):
        row = (_project_action("app-start", {"app": name}).get("apps") or [{}])[0]
        load = _follow(row.get("load") or {}, str(row.get("asset") or ""))
    if load.get("state") != "ready":
        _fail(EXIT_START_FAILED, "APP_NOT_STARTED", f"{name}: {load.get('detail') or load.get('state') or 'failed'}")
    page = next((r for r in _project_action("app-ports").get("ports") or []
                 if r["app"] == name and r["process"] == "page"), None)
    port = (page or {}).get("port") or (page or {}).get("declared")
    return int(port) if port else None


def _follow(load: dict, asset: str) -> dict:
    """Follow a load to its verdict, as ``flow project load --wait`` does — a setup run and its fixer
    included: the fixer is a step of that run."""
    import time  # noqa: PLC0415

    while load.get("state") == "running":
        time.sleep(2)
        load = _project_action(f"load-state?asset={asset}") or load
    return load


@app_app.command("ports", help="The port each app of this project declares, and where it runs now.")
def app_ports_cmd(
    bare: Annotated[Optional[str], typer.Option("--bare", help="Print only the live (else declared) port of APP or APP/SERVICE.")] = None,
) -> None:
    """The one place an agent, a wizard step or a person reads an app's port — never a guess, never a
    number copied into a prompt. ``--bare shop`` or ``--bare shop/api`` prints one number for ``$(...)``."""
    rows = _project_action("app-ports").get("ports") or []
    if bare is None:
        _ok({"ports": rows})
        return
    name, _, process = bare.partition("/")
    row = next((r for r in rows if r["app"] == name and r["process"] == (process or "page")), None)
    port = (row or {}).get("port") or (row or {}).get("declared")
    if not port:
        _fail(EXIT_NOT_FOUND, "NO_PORT", f"{bare} declares no port and is not running")
    typer.echo(str(port))


@app_app.command("stop", help="Stop an app of this project on this machine, whoever started it.")
def app_stop_cmd(name: Annotated[str, typer.Argument(help="The app's name.")]) -> None:
    _ok(_project_action("app-stop", {"app": name}))


@app_app.command("restart", help="Stop an app of this project and start it again on its port.")
def app_restart_cmd(name: Annotated[str, typer.Argument(help="The app's name.")]) -> None:
    _ok(_project_action("app-stop", {"app": name, "restart": True}))


def _resolve_root(root: str | None) -> Path:
    path = Path(root or os.getcwd()).expanduser().resolve()
    if not path.exists() or not path.is_dir():
        _fail(EXIT_INVALID_ARG, "INVALID_ROOT", f"Root is not a directory: {path}")
    return path


def _post_process_action(process_id: str, action: str, body: dict) -> dict:
    server_port = _discover_port()
    url = f"http://127.0.0.1:{server_port}/api/v1/graph/agentic_process/{process_id}/{action}"

    def _on_error(status_code: int, rbody: dict) -> None:
        message = str(rbody.get("message") or f"HTTP {status_code}")
        if status_code == 404:
            _fail(EXIT_NOT_FOUND, "NOT_FOUND", message)
        if status_code == 400:
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", message)
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    return _post_graph_json(url, body, timeout=15, on_error=_on_error)


def _list_webapp_artifacts(process_id: str, query: str) -> list[dict]:
    data = _post_process_action(process_id, "webapp-artifacts", {"query": query})
    artifacts = data.get("artifacts", [])
    return artifacts if isinstance(artifacts, list) else []


def _answers(port: int) -> bool:
    """Something speaks HTTP on ``port`` — asked only of a holder the process table cannot name."""
    from flow_sdk.core.dev_server import loopback_answers  # noqa: PLC0415

    return loopback_answers(port, timeout=2)


def _where(port: int, folder: Path, start_cmd: str, name: str, *, placed: bool = False) -> tuple[int, bool]:
    """``(the port the app is or will be on, it is already serving)`` — by the one port rule
    (``flow_sdk/core/app_ports.py``), never "something answers on that port".

    The app already running from its folder is the app, on whatever port it listens. A port ANOTHER
    program holds is an error that names it: showing that program as the app is the failure this
    replaces. ``placed``: the backend just started (or found) it on ``port`` — that is the answer; a
    folder search would take the app's own API, serving from the same folder, for its page."""
    if placed:
        return port, True
    from flow_sdk.core import app_ports  # noqa: PLC0415

    snapshot = app_ports.listeners()
    mine = app_ports.of_app(snapshot, folder, start_cmd)
    if mine:
        return mine[0].port, True
    found = app_ports.decide(app_ports.Declared(port, required=False), mine, snapshot, answers=_answers)
    if found.state == "conflict":
        _fail(EXIT_START_FAILED, "PORT_HELD", f"{name}: {found.note}")
    return found.port, found.state == "running"


def _register_webapp(process_id: str, payload: dict) -> dict:
    return _post_process_action(process_id, "register-webapp-artifact", payload)


def _open_artifact(
    artifact: dict,
    *,
    process_id: str,
    root: Path,
    port_override: int | None,
    no_start: bool,
    timeout: float,
    placed: bool = False,
) -> dict | None:
    port = port_override or _artifact_port(artifact)
    if port is None:
        return None

    command = _artifact_start_cmd(artifact)
    cwd = _artifact_cwd(artifact, root)
    started = False
    pid = None
    log_file = None

    port, serving = _where(port, cwd, command or "", artifact.get("name") or "webapp", placed=placed)
    if not no_start and not serving:
        if not command:
            return None
        pid, log_file = _start_detached(command, cwd=cwd, port=port, name=artifact.get("name") or "webapp")
        started = True
        if not _wait_for_port(port, timeout):
            _fail(
                EXIT_START_FAILED,
                "APP_START_TIMEOUT",
                f"Started artifact but port {port} did not become ready within {timeout:.0f}s. Log: {log_file}",
            )

    data = _register_webapp(
        process_id,
        {
            "artifact_id": artifact.get("id"),
            "name": artifact.get("name") or f"Web App {port}",
            "path": _artifact_path(artifact, root) or str(cwd),
            "port": str(port),
            "start_cmd": command,
            "health": _artifact_health(artifact),
            "description": artifact.get("description") or "Web application",
            "show": True,
        },
    )
    return {
        "source": "artifact",
        "artifact": data.get("artifact"),
        "deployment": data.get("deployment"),
        "shown": data.get("shown"),
        "port": port,
        "url": f"http://127.0.0.1:{port}",
        "started": started,
        "pid": pid,
        "log": log_file,
    }


def _open_candidate(
    candidate: WebAppCandidate,
    *,
    process_id: str,
    request: str,
    dist: str | None = None,
    port_override: int | None,
    no_start: bool,
    install: bool,
    timeout: float,
    placed: bool = False,
) -> dict:
    app_dir = Path(candidate.path)
    if candidate.kind == "static":
        port = port_override or candidate.port or _choose_static_port()
    else:
        port = port_override or candidate.port
    if port is None:
        _fail(EXIT_INVALID_ARG, "NO_PORT", f"Could not infer a port for {candidate.name}")

    port, serving = _where(port, app_dir, candidate.start_cmd, candidate.name, placed=placed)
    start_cmd = candidate.start_cmd.format(port=port)
    started = False
    pid = None
    log_file = None

    if install and candidate.kind != "static":
        _install_dependencies_if_needed(app_dir, start_cmd)

    if not no_start and not serving:
        pid, log_file = _start_detached(start_cmd, cwd=app_dir, port=port, name=candidate.name)
        started = True
        if not _wait_for_port(port, timeout):
            _fail(
                EXIT_START_FAILED,
                "APP_START_TIMEOUT",
                f"Started {candidate.name} but port {port} did not become ready within {timeout:.0f}s. Log: {log_file}",
            )

    data = _register_webapp(
        process_id,
        {
            "name": candidate.name,
            "path": str(app_dir),
            "port": str(port),
            "start_cmd": start_cmd,
            "health": candidate.health,
            "description": f"{candidate.kind} web app at {app_dir}",
            # Names the built output the backend should serve as this app's
            # delivery. Omitted, the backend looks for a conventional build dir
            # and falls back to the app folder itself when it is already static.
            "dist": dist,
            "metadata": {
                "app_kind": candidate.kind,
                "evidence": candidate.evidence,
                "match_query": request,
                "opened_from": "discovery",
            },
            "show": True,
        },
    )
    return {
        "source": "discovery",
        "candidate": candidate.to_dict(),
        "artifact": data.get("artifact"),
        "deployment": data.get("deployment"),
        "shown": data.get("shown"),
        "port": port,
        "url": f"http://127.0.0.1:{port}",
        "started": started,
        "pid": pid,
        "log": log_file,
    }


def _select_artifact(artifacts: list[dict], query: str, root: Path) -> dict | None:
    scored: list[tuple[int, dict]] = []
    for artifact in artifacts:
        port = _artifact_port(artifact)
        if port is None:
            continue
        score = _artifact_score(artifact, query, root)
        if score <= -100:
            continue
        scored.append((score, artifact))
    if not scored:
        return None
    scored.sort(key=lambda item: item[0], reverse=True)
    return scored[0][1]


def _artifact_score(artifact: dict, query: str, root: Path) -> int:
    terms = _query_terms(query)
    fields = " ".join(
        str(artifact.get(k) or "")
        for k in ("name", "description", "kind")
    ).lower()
    score = 25
    path = _artifact_path(artifact, root)
    if path:
        try:
            if Path(path).expanduser().resolve().is_relative_to(root):
                score += 20
        except (OSError, RuntimeError):
            pass
    if not terms:
        return score
    matched = sum(1 for term in terms if term in fields)
    return score + matched * 40 if matched else -120


def _query_terms(query: str) -> set[str]:
    generic = {"open", "start", "run", "show", "the", "a", "an", "app", "application", "web", "ui", "please"}
    words = set(re.findall(r"[a-z0-9][a-z0-9_-]*", query.lower()))
    return {word for word in words if word not in generic}


def _dev_endpoint(artifact: dict) -> dict:
    """The artifact's dev-server endpoint (a ``proxy`` backend) as ``webapp-artifacts`` reports it, or ``{}``."""
    for endpoint in artifact.get("endpoints") or []:
        backend = endpoint.get("backend") or {}
        if backend.get("type") == "proxy":
            return backend
    return {}


def _artifact_port(artifact: dict) -> int | None:
    try:
        port = int(str(_dev_endpoint(artifact).get("port")))
    except (TypeError, ValueError):
        return None
    return port if 0 < port <= 65535 else None


def _artifact_start_cmd(artifact: dict) -> str:
    return str(_dev_endpoint(artifact).get("start_cmd") or "").strip()


def _artifact_health(artifact: dict) -> str:
    return str(_dev_endpoint(artifact).get("health") or "/")


def _artifact_cwd(artifact: dict, root: Path) -> Path:
    raw = _artifact_path(artifact, root)
    if not raw:
        return root
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve() if path.exists() else root


def _artifact_path(artifact: dict, root: Path) -> str:
    origin = artifact.get("origin")
    if not isinstance(origin, dict):
        return ""
    rel_path = str(origin.get("rel_path") or ".").strip()
    if origin.get("kind") == "local":
        base = str(origin.get("base") or "").strip()
        return str(Path(base) / rel_path) if base else ""
    # A git origin is checkout-independent.  The app command already knows the
    # active checkout root, so its repo-relative placement resolves from there.
    if origin.get("kind") == "git":
        return str(root / rel_path)
    return ""


_STATIC_PORT_RANGE = range(8000, 8100)


def _choose_static_port() -> int:
    """A free port in the dev band, else one the OS assigns — never a port an app of this instance
    declares (``app_ports.free_port`` is the one picker)."""
    from flow_sdk.core import app_ports  # noqa: PLC0415

    return app_ports.free_port(_declared_ports(), _STATIC_PORT_RANGE)


def _declared_ports() -> set[int]:
    """The ports this project's apps declare, as the backend knows them. Empty when it cannot be asked:
    a picker must still answer with the backend down, or outside a project."""
    from flow_sdk.cli.commands._common import local_get  # noqa: PLC0415

    try:
        url = _project_action_url("app-ports", required=False)
        rows = ((local_get(url, timeout=5).json().get("data") or {}).get("ports") or []) if url else []
    except (Exception, SystemExit):  # noqa: BLE001 -- no backend, no project: nothing declared that we can know of
        return set()
    return {int(row["declared"]) for row in rows if row.get("declared")}


def _install_dependencies_if_needed(app_dir: Path, start_cmd: str) -> None:
    if (app_dir / "node_modules").exists():
        return
    if not (app_dir / "package.json").exists():
        return
    install_cmd = _install_command(start_cmd, app_dir)
    from flow_sdk.core.dev_server import log_dir  # noqa: PLC0415

    logs = log_dir()
    logs.mkdir(parents=True, exist_ok=True)
    log_file = logs / f"install-{re.sub(r'[^a-zA-Z0-9_.-]+', '-', app_dir.name) or 'app'}.log"
    with log_file.open("ab") as log:
        result = subprocess.run(
            install_cmd,
            cwd=str(app_dir),
            shell=True,
            stdin=subprocess.DEVNULL,
            stdout=log,
            stderr=subprocess.STDOUT,
            timeout=300,
            check=False,
        )
    if result.returncode != 0:
        _fail(EXIT_START_FAILED, "INSTALL_FAILED", f"Dependency install failed for {app_dir}. Log: {log_file}")


def _install_command(start_cmd: str, app_dir: Path) -> str:
    from flow_sdk.core.dev_server import install_command  # noqa: PLC0415 — one package-manager rule

    return install_command(start_cmd, app_dir)