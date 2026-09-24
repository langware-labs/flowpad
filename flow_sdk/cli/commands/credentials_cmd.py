"""``flow credentials ...`` — a project's credentials by name, from the command line.

    flow credentials check <name>                  — are its values present? (exit code)
    flow credentials set <name> VAR=VALUE …        — store values (declares it from its template)
    flow credentials set <name> --from-inputs      — store what a wizard step was given

Both are what ``flow project setup`` runs: ``check`` is every key step's completion check, and
``set`` is how a typed answer — or an agent following the credential's ``setup`` — stores a value.
Neither ever prints a value.

Exit codes are ``ExitCode``'s, because a wizard check reads them:

    0  every value it needs in development is present   (set: stored)
    1  not yet: something is missing                     (set: refused — no value, a bad value)
    2  the request itself was wrong

Over HTTP when a backend runs (it holds the SQLite writer), in-process when none does — the same
service functions either way (``builtin/credential_service``).
"""
from __future__ import annotations

import asyncio
import os
from typing import Any, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import (
    EXIT_INVALID_ARG,
    discover_port,
    fail,
    get_graph_json,
    graph_url,
    ok,
    post_graph_json,
    project_for_path,
)
from flow_sdk.schema.data_spec.project_setup_spec import input_name
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

credentials_app = typer.Typer(
    name="credentials",
    help="Check and store a project's credentials by name. Never prints a value.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_NOT_YET = int(ExitCode.NOT_YET)



def _here(coro: Any) -> Any:
    """Run a service coroutine in this process — the transport when no backend runs."""
    return asyncio.run(coro)


def _url(port: int) -> str:
    return graph_url(port, "compute_node/@local/credentials")


def _refused(status: int, body: dict) -> None:
    fail(EXIT_NOT_YET, str((body.get("data") or {}).get("error_code") or "REFUSED"), str(body.get("message") or f"HTTP {status}"))


async def _project(project_id: Optional[str]):
    from flow_sdk.builtin.project import Project  # noqa: PLC0415

    if project_id:
        return await Project.get_by_id(project_id)
    return await Project.find_by_cwd(os.getcwd())


def _project_id(port: Optional[int], project_id: Optional[str]) -> Optional[str]:
    """``--project``, else the project whose folder is the working directory, else none (user scope)."""
    if project_id or port is None:
        return project_id
    from flow_sdk.fs_store.path_utils import is_valid_project_cwd  # noqa: PLC0415

    cwd = os.getcwd()
    return project_for_path(port, cwd, create=False) if is_valid_project_cwd(cwd, include_temp=True) else None


def status_row(status: dict, name: str) -> Optional[dict]:
    """The row ``name`` resolves to — the project's own before the user's (``SecretPack.get``'s order)."""
    rows = [row for row in status.get("credentials") or [] if row.get("name") == name]
    return next((row for row in rows if row.get("scope") == "project"), rows[0] if rows else None)


def _status(project_id: Optional[str]) -> dict:
    port = discover_port(required=False)
    if port is not None:
        params = {"project_id": pid} if (pid := _project_id(port, project_id)) else None
        return get_graph_json(f"{_url(port)}/status", params=params, on_error=_refused) or {}

    async def here() -> dict:
        from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

        return (await credentials_status(await _project(project_id))).model_dump(mode="json")

    return _here(here())


def _set(name: str, values: dict[str, str], project_id: Optional[str]) -> dict:
    port = discover_port(required=False)
    if port is not None:
        payload = {"name": name, "values": values, "project_id": _project_id(port, project_id)}
        return post_graph_json(f"{_url(port)}/set", payload, on_error=_refused)

    async def here() -> dict:
        from flow_sdk.builtin.credential_service import CredentialError, set_credential_by_name  # noqa: PLC0415

        project = await _project(project_id)
        try:
            spec = await set_credential_by_name(name, values, project_id=str(project.id) if project else None)
        except CredentialError as e:
            fail(EXIT_NOT_YET, e.code or "REFUSED", str(e))
        return {"typeid": str(spec.typeid), "name": spec.name, "scope": spec.scope}

    return _here(here())


def _missing(row: Optional[dict]) -> list[str]:
    if row is None:
        return []
    return [v["env_var"] for v in row.get("vars") or [] if v.get("required") and not v.get("present")]


@credentials_app.command("check")
def check_credential(
    name: Annotated[str, typer.Argument(help="The credential's name (e.g. telegram).")],
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
) -> None:
    """Exit 0 when every value NAME needs in development is present; 1 when not. Prints no value."""
    row = status_row(_status(project), name)
    missing = _missing(row)
    ready = row is not None and row.get("state") == "connected"
    ok({"name": name, "declared": row is not None, "ready": ready, "missing": missing})
    if not ready:
        raise typer.Exit(EXIT_NOT_YET)


def _pairs(assignments: list[str]) -> dict[str, str]:
    values: dict[str, str] = {}
    for item in assignments:
        var, sep, value = item.partition("=")
        if not sep or not var.strip():
            fail(EXIT_INVALID_ARG, "INVALID_ARG", f"expected VAR=VALUE, got {item.split('=')[0]!r}")
        values[var.strip()] = value
    return values


def from_inputs(name: str, env: Optional[dict[str, str]] = None) -> dict[str, str]:
    """The values a wizard step bound for ``name``: every ``<name>__<VAR>`` in its environment."""
    from flow_sdk.core.wizard.state import input_env  # noqa: PLC0415 — the one spelling of a step value's env name

    env = os.environ if env is None else env
    (prefix,) = input_env({input_name(name, ""): ""})
    return {key[len(prefix):]: value for key, value in env.items() if key.startswith(prefix) and value}


@credentials_app.command("set")
def set_credential(
    name: Annotated[str, typer.Argument(help="The credential's name (e.g. telegram).")],
    assignments: Annotated[Optional[list[str]], typer.Argument(help="VAR=VALUE pairs.")] = None,
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
    inputs: Annotated[bool, typer.Option("--from-inputs", help="Take the values a `flow project setup` step was given.")] = False,
) -> None:
    """Store NAME's values in development. A name not declared yet is added from its template."""
    values: dict[str, Any] = {**(from_inputs(name) if inputs else {}), **_pairs(assignments or [])}
    if not any(values.values()):
        fail(EXIT_NOT_YET, "NO_VALUE", f"no value given for {name}")
    stored = _set(name, values, project)
    ok({"name": name, "stored": sorted(k for k, v in values.items() if v), "typeid": stored.get("typeid")})
