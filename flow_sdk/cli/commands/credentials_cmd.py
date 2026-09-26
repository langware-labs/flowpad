"""``flow credentials ...`` — a project's credentials by name, from the command line.

    flow credentials declare <manifest.json>       — declare a credential in this folder's project
    flow credentials check <name>                  — are its values present? (exit code)
    flow credentials set <name> VAR=VALUE …        — store values (declares it from its template)
    flow credentials set <name> --stdin            — store VAR=VALUE lines read from stdin
    flow credentials set <name> --from-inputs      — store what a wizard step was given
    flow credentials delete <name>                 — remove it and its values from every store
    flow credentials audit --project … --name …    — is anything deleted still stored anywhere?

``declare`` is how a project says what it needs; ``check`` and ``set`` are what ``flow project setup``
runs: ``check`` is every key step's completion check, and ``set`` is how a typed answer — or an agent
following the credential's ``setup`` — stores a value. An agent stores through ``--stdin``, piping the
value from where it is produced: an argument is visible to every process on the box and lands in the
agent's transcript. None of them ever prints a value.

Exit codes are ``ExitCode``'s, because a wizard check reads them:

    0  every value it needs in development is present   (set: stored)
    1  not yet: something is missing                     (set: refused — no value, a bad value)
    2  the request itself was wrong
    7  delete: a store still holds a value, or could not be reached — the credential stays
       audit: a store could not be read (unchecked is not clean; audit exits 1 on a leftover)

Over HTTP when a backend runs (it holds the SQLite writer), in-process when none does — the same
service functions either way (``builtin/credential_service``).
"""
from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path
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
    """The row ``name`` resolves to — the project's own before the user's (``Credential.get``'s order)."""
    rows = [row for row in status.get("credentials") or [] if row.get("name") == name]
    return next((row for row in rows if row.get("scope") == "project"), rows[0] if rows else None)


def _status(project_id: Optional[str], deployment_id: Optional[str] = None) -> dict:
    port = discover_port(required=False)
    if port is not None:
        params = {"project_id": pid} if (pid := _project_id(port, project_id)) else {}
        if deployment_id:
            params["deployment_id"] = deployment_id
        return get_graph_json(f"{_url(port)}/status", params=params or None, on_error=_refused) or {}

    async def here() -> dict:
        from flow_sdk.builtin.credential_status import credentials_status  # noqa: PLC0415

        return (await credentials_status(await _project(project_id), deployment_id or "")).model_dump(mode="json")

    return _here(here())


def _set(name: str, values: dict[str, str], project_id: Optional[str], deployment_id: Optional[str] = None) -> dict:
    port = discover_port(required=False)
    if port is not None:
        payload = {"name": name, "values": values, "project_id": _project_id(port, project_id), "deployment_id": deployment_id}
        return post_graph_json(f"{_url(port)}/set", payload, on_error=_refused)

    async def here() -> dict:
        from flow_sdk.builtin.credential_service import CredentialError, set_credential_by_name  # noqa: PLC0415

        project = await _project(project_id)
        try:
            spec = await set_credential_by_name(
                name, values, project_id=str(project.id) if project else None, deployment_id=deployment_id
            )
        except CredentialError as e:
            fail(EXIT_NOT_YET, e.code or "REFUSED", str(e))
        return {"typeid": str(spec.typeid), "name": spec.name, "scope": spec.scope}

    return _here(here())


def _delete(typeid: str) -> dict:
    port = discover_port(required=False)
    if port is not None:
        return post_graph_json(f"{_url(port)}/delete", {"typeid": typeid}, on_error=_refused)

    async def here() -> dict:
        from flow_sdk.builtin.credential_service import CredentialError, delete_credential  # noqa: PLC0415

        try:
            return (await delete_credential(typeid)).model_dump(mode="json")
        except CredentialError as e:
            fail(EXIT_NOT_YET, e.code or "REFUSED", str(e))

    return _here(here())


def _audit(payload: dict) -> dict:
    """This instance's stores (``sweep_local``): the backend's when one runs."""
    port = discover_port(required=False)
    if port is not None:
        return post_graph_json(f"{_url(port)}/audit", payload, on_error=_refused)
    from flow_sdk.builtin.credential_sweep import sweep_local  # noqa: PLC0415

    return _here(sweep_local(**payload)).model_dump(mode="json")


def _declare(manifest: dict, project_id: Optional[str]) -> dict:
    """Declare ``manifest`` in the project — the cwd's, minted when the folder has none."""
    port = discover_port(required=False)
    if port is not None:
        pid = project_id or project_for_path(port, os.getcwd(), create=True)
        return post_graph_json(f"{_url(port)}/declare", {"manifest": manifest, "project_id": pid}, on_error=_refused)

    async def here() -> dict:
        from flow_sdk.builtin.credential_service import CredentialError, declare_credential  # noqa: PLC0415
        from flow_sdk.builtin.project import Project  # noqa: PLC0415

        project = await (Project.get_by_id(project_id) if project_id else Project.recover_by_path(os.getcwd()))
        if project is None:
            fail(EXIT_INVALID_ARG, "NO_PROJECT", f"no project {project_id}" if project_id
                 else f"{os.getcwd()} cannot be a project folder; pass --project or cd into one")
        try:
            spec = await declare_credential(manifest, project_id=str(project.id))
        except CredentialError as e:
            fail(EXIT_NOT_YET, e.code or "REFUSED", str(e))
        return {"typeid": str(spec.typeid), "name": spec.name, "scope": spec.scope, "project_id": str(project.id)}

    return _here(here())


@credentials_app.command("declare")
def declare_credential(
    manifest: Annotated[Path, typer.Argument(help="A credential.json manifest: name, vars, setup (no values).")],
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's, created if none).")] = None,
) -> None:
    """Declare the credential MANIFEST describes in the project. It must say how its values are
    obtained (``setup``); it never carries a value."""
    try:
        body = json.loads(manifest.read_text(encoding="utf-8"))
    except (OSError, ValueError) as e:
        fail(EXIT_INVALID_ARG, "INVALID_ARG", f"cannot read {manifest}: {e}")
    if not isinstance(body, dict):
        fail(EXIT_INVALID_ARG, "INVALID_ARG", f"{manifest} is not a JSON object")
    saved = _declare(body, project)
    ok({key: saved.get(key) for key in ("name", "typeid", "scope", "project_id")})


def _missing(row: Optional[dict]) -> list[str]:
    if row is None:
        return []
    return [v["env_var"] for v in row.get("vars") or [] if v.get("required") and not v.get("present")]


_DEPLOYMENT = typer.Option("--deployment", help="A deployment id (default: this computer).")


@credentials_app.command("check")
def check_credential(
    name: Annotated[str, typer.Argument(help="The credential's name (e.g. telegram).")],
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
    deployment: Annotated[Optional[str], _DEPLOYMENT] = None,
) -> None:
    """Exit 0 when every value NAME needs at the deployment (default: this computer) is present; 1
    when not. Prints no value."""
    row = status_row(_status(project, deployment), name)
    missing = _missing(row)
    ready = row is not None and row.get("state") == "connected"
    ok({"name": name, "declared": row is not None, "ready": ready, "missing": missing})
    if not ready:
        raise typer.Exit(EXIT_NOT_YET)


def _stdin_pairs() -> list[str]:
    """``VAR=VALUE`` lines from stdin; blank lines and ``#`` comments skipped."""
    return [line for line in map(str.strip, sys.stdin.read().splitlines()) if line and not line.startswith("#")]


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
    stdin: Annotated[bool, typer.Option("--stdin", help="Read VAR=VALUE lines from stdin — how an agent stores a value it must not print.")] = False,
    deployment: Annotated[Optional[str], _DEPLOYMENT] = None,
) -> None:
    """Store NAME's values where the deployment (default: this computer) keeps them — for a cloud
    deployment, the hub, which places them on its machine. A name not declared yet is added from its
    template."""
    values: dict[str, Any] = {
        **(from_inputs(name) if inputs else {}), **_pairs(_stdin_pairs() if stdin else []), **_pairs(assignments or []),
    }
    if not any(values.values()):
        fail(EXIT_NOT_YET, "NO_VALUE", f"no value given for {name}")
    stored = _set(name, values, project, deployment)
    ok({"name": name, "stored": sorted(k for k, v in values.items() if v), "typeid": stored.get("typeid")})


@credentials_app.command("delete")
def delete_credential_cmd(
    name: Annotated[str, typer.Argument(help="The credential's name (e.g. telegram).")],
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
) -> None:
    """Remove NAME — the project's own before the user's — and its values from every store:
    the vault and every ``.env*`` file, in every environment. Prints what each store did, names only."""
    row = status_row(_status(project), name)
    if row is None:
        fail(int(ExitCode.NOT_FOUND), "NOT_FOUND", f"no credential named {name}")
    result = _delete(str(row.get("typeid") or ""))
    if not result.get("removed"):
        fail(int(ExitCode.REFUSED), "NOT_REMOVED", f"{name} was not fully deleted", result)
    ok({"name": name, **result})


@credentials_app.command("audit")
def audit(
    project: Annotated[Optional[str], typer.Option("--project", help="A deleted (or deleting) project's id.")] = None,
    agent: Annotated[Optional[str], typer.Option("--agent", help="A deleted agent's id.")] = None,
    deployment: Annotated[Optional[list[str]], typer.Option("--deployment", help="A deleted deployment's id (repeatable).")] = None,
    name: Annotated[Optional[list[str]], typer.Option("--name", help="A deleted variable's name (repeatable).")] = None,
    root: Annotated[Optional[list[str]], typer.Option("--root", help="Another folder whose .env* files to read.")] = None,
    hub_root: Annotated[Optional[str], typer.Option("--hub-root", help="A local hub checkout: read its secret store.")] = None,
    e2b: Annotated[bool, typer.Option("--e2b", help="List live e2b sandboxes labelled with the agent (E2B_API_KEY).")] = False,
) -> None:
    """Sweep every store for what should be gone. Names only. Exit 1 on a leftover, 7 when a store could not be read."""
    from flow_sdk.builtin.credential_sweep import SweepSpec, merge, sweep_outside  # noqa: PLC0415

    local = _audit({"project_id": project or "", "names": name or [], "roots": [str(Path(r).resolve()) for r in root or []]})
    outside = _here(sweep_outside(
        ids=[project or "", agent or "", *(deployment or [])], agent_id=agent or "",
        hub_root=Path(hub_root).resolve() if hub_root else None, e2b=e2b,
    ))
    result = merge(SweepSpec.model_validate(local), outside).model_dump(mode="json")
    if result["unchecked"]:
        fail(int(ExitCode.REFUSED), "UNCHECKED", "a store could not be read", result)
    if result["found"]:
        fail(EXIT_NOT_YET, "LEFTOVERS", f"{len(result['found'])} leftover secret(s)", result)
    ok(result)


@credentials_app.command("diff")
def diff(
    first: Annotated[str, typer.Argument(help="A deployment id, or 'here' for this computer.")],
    second: Annotated[str, typer.Argument(help="Another deployment id, or 'here'.")],
    project: Annotated[Optional[str], typer.Option("--project", help="Project id (default: the working directory's).")] = None,
) -> None:
    """Which variables each deployment has a value for, and where it keeps them. Names only."""
    def presence(deployment: str) -> dict[str, dict]:
        status = _status(project, None if deployment == "here" else deployment)
        return {v["env_var"]: {"present": v.get("present"), "store": v.get("store")}
                for row in status.get("credentials") or [] for v in row.get("vars") or []}

    a, b = presence(first), presence(second)
    rows = [{"name": n, first: a.get(n), second: b.get(n)} for n in sorted(set(a) | set(b))]
    ok({"differ": [r for r in rows if (r[first] or {}).get("present") != (r[second] or {}).get("present")], "all": rows})


@credentials_app.command("use-mine")
def use_mine_cmd(
    deployment: Annotated[str, typer.Argument(help="The deployment whose store gets this computer's values.")],
    name: Annotated[Optional[list[str]], typer.Option("--name", help="A variable to copy (repeatable; default: what it lacks).")] = None,
) -> None:
    """Copy this computer's values into the deployment's store — for a cloud deployment the hub, which
    places them on its machine. Values move machine to hub; nothing is printed but names."""
    port = discover_port(required=False)
    payload = {"deployment_id": deployment, "names": name or None}
    if port is not None:
        result = post_graph_json(f"{_url(port)}/use-mine", payload, on_error=_refused)
    else:
        async def here() -> dict:
            from flow_sdk.builtin.credential_service import CredentialError, use_mine  # noqa: PLC0415

            try:
                return await use_mine(deployment, name or None)
            except CredentialError as e:
                fail(int(ExitCode.REFUSED), e.code or "REFUSED", str(e))

        result = _here(here())
    ok(result)
    if result.get("not_here"):
        raise typer.Exit(EXIT_NOT_YET)
