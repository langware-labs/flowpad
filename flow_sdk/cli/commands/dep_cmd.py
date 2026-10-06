"""``flow dep`` — a project's dependencies (``flow.json``), through the running app.

    flow dep list                                  # every declared dependency and its state here
    flow dep add ../langware-os                    # a folder in git is written as its repo
    flow dep add git+https://github.com/acme/handbook#main --path legal --optional
    flow dep add hub:8c1f0b2e-…                    # a hub project
    flow dep remove langware-os                    # leaves the folder on disk alone
    flow dep sync [--update]                       # fetch what is missing; --update pulls Flowpad's clones
    flow dep install policies                      # bring in an optional one
    flow dep check langware-os                     # exit 0 when it is ready here, 4 when not

``--project`` names the project; the default is the project whose folder is the working
directory. Every command prints one JSON envelope.
"""
from __future__ import annotations

import os
from typing import NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    caller_abs_path,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
    project_for_path,
)
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

dep_app = typer.Typer(name="dep", help="A project's dependencies (flow.json).", add_completion=False, no_args_is_help=True)

#: A dependency can be a clone: allow for one.
FETCH_SECONDS = 600

ProjectOpt = Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")]


def _refused(status: int, body: dict) -> NoReturn:
    code = int(ExitCode.NOT_FOUND) if status == 404 else int(ExitCode.REFUSED)
    fail(code, "REFUSED", str(body.get("message") or f"HTTP {status}"), body.get("data") or None)


def _project(port: int, project: Optional[str]) -> str:
    if project:
        return project.removeprefix("project-")
    found = project_for_path(port, os.getcwd(), create=False)
    if not found:
        fail(int(ExitCode.NOT_FOUND), "NO_PROJECT", f"{os.getcwd()} is not a project folder; pass --project or cd into one")
    return found


def _url(port: int, project_id: str, action: str) -> str:
    return graph_url(port, f"project/{project_id}/{action}")


@dep_app.command("list")
def list_(project: ProjectOpt = None) -> None:
    """Every declared dependency and its state on this machine."""
    port = discover_port(required=True)
    ok(get_graph_json(_url(port, _project(port, project), "dependencies"), on_error=_refused) or {})


@dep_app.command("add")
def add(
    source: Annotated[str, typer.Argument(help="A folder, a git URL, or git+…/hub:…/file:… .")],
    name: Annotated[Optional[str], typer.Option("--name", help="The dependency's name (default: the folder or repo name).")] = None,
    path: Annotated[Optional[str], typer.Option("--path", help="A folder inside the source.")] = None,
    optional: Annotated[bool, typer.Option("--optional", help="Declare it under optionalDependencies.")] = False,
    project: ProjectOpt = None,
) -> None:
    """Declare SOURCE in flow.json and resolve it."""
    port = discover_port(required=True)
    raw = source.strip()
    if not raw.startswith(("git+", "hub:", "file:")) and os.path.isdir(os.path.expanduser(raw)):
        raw = caller_abs_path(raw)   # a folder is the CALLER's, not the server's working directory
    body = {"source": raw, "name": name or "", "path": path or "", "optional": optional}
    ok(post_graph_json(_url(port, _project(port, project), "add-dependency"), body, timeout=FETCH_SECONDS, on_error=_refused))


@dep_app.command("remove")
def remove(name: Annotated[str, typer.Argument(help="The dependency's name.")], project: ProjectOpt = None) -> None:
    """Drop NAME from flow.json; the folder on disk is never touched."""
    port = discover_port(required=True)
    ok(post_graph_json(_url(port, _project(port, project), "remove-dependency"), {"name": name}, on_error=_refused))


@dep_app.command("sync")
def sync(
    update: Annotated[bool, typer.Option("--update", help="Fast-forward the clones Flowpad made.")] = False,
    project: ProjectOpt = None,
) -> None:
    """Fetch every dependency that is missing here, link and index it."""
    port = discover_port(required=True)
    ok(post_graph_json(_url(port, _project(port, project), "resolve-dependencies"), {"update": update},
                       timeout=FETCH_SECONDS, on_error=_refused))


@dep_app.command("install")
def install(name: Annotated[str, typer.Argument(help="An optional dependency's name.")], project: ProjectOpt = None) -> None:
    """Bring in the optional dependency NAME."""
    port = discover_port(required=True)
    ok(post_graph_json(_url(port, _project(port, project), "install-dependency"), {"name": name},
                       timeout=FETCH_SECONDS, on_error=_refused))


@dep_app.command("check")
def check(name: Annotated[str, typer.Argument(help="The dependency's name.")], project: ProjectOpt = None) -> None:
    """Exit 0 when NAME is ready here, NOT_YET otherwise — the setup wizard's completion check."""
    port = discover_port(required=True)
    data = get_graph_json(_url(port, _project(port, project), "dependencies"), on_error=_refused) or {}
    row = next((d for d in data.get("dependencies") or [] if d.get("name") == name and not d.get("via")), None)
    if row is None:
        fail(int(ExitCode.NOT_FOUND), "NOT_FOUND", f"{name!r} is not declared in flow.json")
    if row.get("state") != "ready":
        fail(int(ExitCode.NOT_YET), "NOT_READY", f"{name}: {row.get('state')} — {row.get('reason') or ''}".rstrip(" —"), {"dependency": row})
    ok({"dependency": row})
