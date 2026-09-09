"""`flow asset ...` CLI subgroup — the shell form of one-click install.

``flow asset install <typeid>`` runs the SAME desk code the hub's Install
button reaches through the Add-asset dialog (``project/<id>/install-published``):
the desk asks the hub which project published the typeid, fetches the files
from the row's origin, copies them into the target project at the type's
placement, indexes them keeping the publisher's id, and records the row in
``deps.json``. The hub's install snippet ends with this line, so a machine
that had no desktop a minute ago can install with a paste.

The target project is ``--project``, else the project whose folder is the
working directory (created if the folder is not a project yet).

Error contract (agents parse these):

    exit 0 — installed; stdout carries the desk's result (id, posix_path, installed row)
    exit 2 — invalid arguments (malformed typeid, cwd that cannot be a project)
    exit 3 — the desk refused (stdout ``code``: not_published, no_origin, missing, exists, same_project, …)
    exit 5 — connection error (no running instance, server unreachable)
"""

from __future__ import annotations

import os
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
    graph_url as _graph_url,
)
from flow_sdk.cli.commands._common import (
    ok as _ok,
)
from flow_sdk.cli.commands._common import (
    post_graph_json as _post_graph_json,
)
from flow_sdk.cli.commands._common import (
    project_for_path as _project_for_path,
)

asset_app = typer.Typer(
    name="asset",
    help="Install published assets into a project.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_REFUSED = 3


@asset_app.command("install", help="Install a published asset (a TypeId like 'skill-<uuid>') into a project.")
def install_asset(
    typeid: Annotated[str, typer.Argument(help="The published asset's TypeId, as the hub's Discover page shows it.")],
    project: Annotated[
        Optional[str], typer.Option("--project", "-p", help="Target project id. Default: the project at the working directory.")
    ] = None,
    overwrite: Annotated[bool, typer.Option("--overwrite", help="Replace a copy the project already holds.")] = False,
) -> None:
    from flow_sdk.schema.data_spec.project_manifest_spec import split_typeid

    typeid = typeid.strip()
    try:
        split_typeid(typeid)
    except ValueError as exc:
        _fail(EXIT_INVALID_ARG, "INVALID_TYPEID", str(exc))
    port = _discover_port()
    project_id = project.strip() if project else _project_for_path(port, os.getcwd(), create=True)
    if not project_id:
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", "the server created no project for this folder")

    def _on_error(status_code: int, body: dict) -> None:
        message = str(body.get("message") or f"HTTP {status_code}")
        data = body.get("data") if isinstance(body.get("data"), dict) else {}
        code = str(data.get("code") or "")
        if status_code == 400 and code:
            _fail(EXIT_REFUSED, "REFUSED", message, {"code": code, "project_id": project_id})
        if status_code == 404:
            _fail(EXIT_REFUSED, "PROJECT_NOT_FOUND", message, {"project_id": project_id})
        _fail(EXIT_CONNECTION_ERROR, "SERVER_ERROR", message)

    data = _post_graph_json(
        _graph_url(port, f"project/{project_id}/install-published"),
        {"typeid": typeid, "overwrite": overwrite},
        timeout=600,
        on_error=_on_error,
    )
    _ok({"project_id": project_id, **data})
