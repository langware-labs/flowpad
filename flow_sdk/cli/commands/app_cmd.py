"""Agent-facing app discovery/open commands."""

from __future__ import annotations

import os
import re
import socket
import subprocess
import time
from pathlib import Path
from typing import Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.app_discovery import WebAppCandidate, discover_webapps
from flow_sdk.cli.commands._common import (
    discover_port as _discover_port,
    fail as _fail,
    ok as _ok,
    post_graph_json as _post_graph_json,
    resolve_process_id as _resolve_process_id,
)


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
    install: Annotated[bool, typer.Option("--install/--no-install", help="Install JS dependencies if node_modules is missing.")] = True,
    timeout: Annotated[float, typer.Option("--timeout", help="Seconds to wait for the port after starting.")] = 75.0,
    max_depth: Annotated[int, typer.Option("--max-depth", help="Maximum directory depth to scan.")] = 6,
) -> None:
    scan_root = _resolve_root(root)
    process_id = _resolve_process_id(process)
    request = query or ""

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
        port_override=port,
        no_start=no_start,
        install=install,
        timeout=timeout,
    )
    _ok(opened)


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
) -> dict | None:
    port = port_override or _artifact_port(artifact)
    if port is None:
        return None

    command = _artifact_start_cmd(artifact)
    cwd = _artifact_cwd(artifact, root)
    started = False
    pid = None
    log_file = None

    if not no_start and not _port_open(port):
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
            "path": artifact.get("path") or str(cwd),
            "port": str(port),
            "start_cmd": command,
            "health": artifact.get("health") or _metadata(artifact).get("health") or "/",
            "description": artifact.get("description") or "Web application",
            "metadata": {**_metadata(artifact), "opened_from": "artifact"},
            "show": True,
        },
    )
    return {
        "source": "artifact",
        "artifact": data.get("artifact"),
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
    port_override: int | None,
    no_start: bool,
    install: bool,
    timeout: float,
) -> dict:
    app_dir = Path(candidate.path)
    if candidate.kind == "static":
        port = port_override or candidate.port or _choose_static_port()
    else:
        port = port_override or candidate.port
    if port is None:
        _fail(EXIT_INVALID_ARG, "NO_PORT", f"Could not infer a port for {candidate.name}")

    start_cmd = candidate.start_cmd.format(port=port)
    started = False
    pid = None
    log_file = None

    if install and candidate.kind != "static":
        _install_dependencies_if_needed(app_dir, start_cmd)

    if not no_start and not _port_open(port):
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
        for k in ("name", "path", "description")
    ).lower()
    score = 25
    path = str(artifact.get("path") or "")
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


def _artifact_port(artifact: dict) -> int | None:
    value = artifact.get("port") or _metadata(artifact).get("port")
    try:
        port = int(str(value))
    except (TypeError, ValueError):
        return None
    return port if 0 < port <= 65535 else None


def _artifact_start_cmd(artifact: dict) -> str:
    value = artifact.get("start_cmd") or _metadata(artifact).get("start_cmd") or _metadata(artifact).get("start-cmd")
    return str(value or "").strip()


def _artifact_cwd(artifact: dict, root: Path) -> Path:
    raw = str(artifact.get("path") or "").strip()
    if not raw:
        return root
    path = Path(raw).expanduser()
    if not path.is_absolute():
        path = root / path
    return path.resolve() if path.exists() else root


def _metadata(artifact: dict) -> dict:
    metadata = artifact.get("metadata")
    return metadata if isinstance(metadata, dict) else {}


def _choose_static_port() -> int:
    for port in range(8000, 8100):
        if not _port_open(port):
            return port
    return _find_free_port()


def _find_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return int(sock.getsockname()[1])


def _port_open(port: int) -> bool:
    try:
        with socket.create_connection(("127.0.0.1", int(port)), timeout=0.5):
            return True
    except OSError:
        return False


def _wait_for_port(port: int, timeout: float) -> bool:
    deadline = time.monotonic() + max(timeout, 0)
    while time.monotonic() <= deadline:
        if _port_open(port):
            return True
        time.sleep(0.25)
    return _port_open(port)


def _start_detached(command: str, *, cwd: Path, port: int, name: str) -> tuple[int | None, str]:
    log_dir = Path.home() / ".flow" / "app-open-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    slug = re.sub(r"[^a-zA-Z0-9_.-]+", "-", name).strip("-") or "webapp"
    log_file = log_dir / f"{slug}-{port}.log"
    log = log_file.open("ab")
    proc = subprocess.Popen(
        command,
        cwd=str(cwd),
        shell=True,
        stdin=subprocess.DEVNULL,
        stdout=log,
        stderr=subprocess.STDOUT,
        start_new_session=True,
    )
    log.close()
    return proc.pid, str(log_file)


def _install_dependencies_if_needed(app_dir: Path, start_cmd: str) -> None:
    if (app_dir / "node_modules").exists():
        return
    if not (app_dir / "package.json").exists():
        return
    install_cmd = _install_command(start_cmd, app_dir)
    log_dir = Path.home() / ".flow" / "app-open-logs"
    log_dir.mkdir(parents=True, exist_ok=True)
    log_file = log_dir / f"install-{re.sub(r'[^a-zA-Z0-9_.-]+', '-', app_dir.name) or 'app'}.log"
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
    if start_cmd.startswith("pnpm "):
        return "pnpm install"
    if start_cmd.startswith("yarn "):
        return "yarn install"
    if start_cmd.startswith("bun "):
        return "bun install"
    if (app_dir / "package-lock.json").exists():
        return "npm ci"
    return "npm install"
