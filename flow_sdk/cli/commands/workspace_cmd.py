"""`flow workspace ...` — list, create, rename and delete workspaces.

A workspace is a folder of related projects (see ``flow_sdk/builtin/workspace.py``).
The default one, "Flowpad", is this instance's workspace root and always exists.
Every command talks to the running instance (``FLOW_INSTANCE``) over the graph API.
"""

from __future__ import annotations

from typing import Any, NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.builtin.workspace import DEFAULT_WORKSPACE_NAME
from flow_sdk.cli.commands._common import _graph_json as graph_json
from flow_sdk.cli.commands._common import (
    caller_abs_path,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
)

workspace_app = typer.Typer(
    name="workspace",
    help="Organise projects into workspaces — folders of related projects.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_NOT_FOUND = 4
EXIT_ACTION_FAILED = 7


def _on_error(not_found: str = ""):
    def handle(status: int, body: dict) -> NoReturn:
        if status == 404 and not_found:
            fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found)
        fail(
            EXIT_ACTION_FAILED,
            str(body.get("error_code") or "ACTION_FAILED"),
            str(body.get("message") or body.get("detail") or f"HTTP {status}"),
        )

    return handle


def _url(path: str) -> str:
    return graph_url(discover_port(), path)


def _row(workspace: dict[str, Any]) -> dict[str, Any]:
    is_default = bool(workspace.get("is_default"))
    root = workspace.get("root_path")
    if not root:
        # The default workspace stores no folder: it is this instance's workspace
        # root, which the CLI resolves for the same FLOW_INSTANCE as the server.
        from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

        root = str(get_instance_settings().workspace_root)
    return {
        "id": workspace.get("id"),
        "name": DEFAULT_WORKSPACE_NAME if is_default else workspace.get("name"),
        "root": root,
        "is_default": is_default,
    }


@workspace_app.command("list", help="Every workspace on this instance, the default one first.")
def list_workspaces() -> None:
    rows = get_graph_json(_url("workspace"), on_error=_on_error()) or []
    workspaces = sorted((_row(w) for w in rows), key=lambda w: (not w["is_default"], str(w["name"] or "").casefold()))
    ok({"workspaces": workspaces})


@workspace_app.command("create", help="Create a workspace; its folder defaults to ~/Flowpad/<name> on prod.")
def create(
    name: str,
    path: Annotated[Optional[str], typer.Option("--path", help="The workspace's folder (created if missing).")] = None,
) -> None:
    payload: dict[str, Any] = {"name": name}
    if path:
        payload["root_path"] = caller_abs_path(path)
    created = post_graph_json(_url("workspace"), payload, on_error=_on_error())
    ok({"workspace": _row(created)})


@workspace_app.command("rename", help="Rename a workspace (its folder stays where it is).")
def rename(workspace_id: str, name: str) -> None:
    updated = graph_json(
        "PATCH",
        _url(f"workspace/{workspace_id}"),
        json={"name": name},
        timeout=15,
        on_error=_on_error(f"Workspace not found: {workspace_id}"),
    )
    ok({"workspace": _row(updated or {})})


@workspace_app.command("delete", help="Forget a workspace. Its folder and projects stay on disk.")
def delete(workspace_id: str) -> None:
    graph_json(
        "DELETE",
        _url(f"workspace/{workspace_id}"),
        timeout=15,
        on_error=_on_error(f"Workspace not found: {workspace_id}"),
    )
    ok({"deleted": workspace_id})


__all__ = ["workspace_app"]
