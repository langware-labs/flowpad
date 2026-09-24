"""``flow connections`` — the CLI presenter for the shared connection core."""

from __future__ import annotations

import asyncio
import json
from typing import Annotated

import typer

from flow_sdk.core.connections import Authorization, list_connections
from flow_sdk.core.connections import connect as connect_provider
from flow_sdk.core.connections.presentation import open_authorization_in_system_browser
from flow_sdk.schema.data_spec.connection_spec import (
    BrowserAuthorization,
    ConnectionCancelled,
    ConnectionConnectError,
    ConnectionStage,
    DeviceAuthorization,
)

connections_app = typer.Typer(
    name="connections",
    help="List and connect this instance's external providers.",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_INVALID_PROVIDER = 2
EXIT_CANCELLED = 4
EXIT_SERVICE = 5
EXIT_AUTH = 6
EXIT_INTERRUPTED = 130


class _CliPresenter:
    async def present(self, authorization: Authorization) -> None:
        if isinstance(authorization, BrowserAuthorization):
            opened = open_authorization_in_system_browser(authorization)
            if opened:
                typer.echo(f"Opened a browser to connect {authorization.provider}.", err=True)
            else:
                typer.echo(f"Open this URL to connect {authorization.provider}: {authorization.url}", err=True)
            return

        if isinstance(authorization, DeviceAuthorization):
            open_authorization_in_system_browser(authorization)
            typer.echo(f"Open: {authorization.verification_uri}", err=True)
            typer.echo(f"Code: {authorization.user_code}", err=True)


def _run(awaitable):
    try:
        return asyncio.run(awaitable)
    except KeyboardInterrupt:
        raise typer.Exit(EXIT_INTERRUPTED) from None


def _error_exit(error: ConnectionConnectError, *, json_output: bool) -> None:
    payload = {
        "ok": False,
        "provider": error.provider,
        "stage": error.stage.value,
        "code": error.code,
        "detail": error.detail,
    }
    if json_output:
        typer.echo(json.dumps(payload), err=True)
    else:
        typer.echo(f"Error [{error.stage.value}/{error.code}]: {error.detail or str(error)}", err=True)

    if isinstance(error, ConnectionCancelled):
        code = EXIT_CANCELLED
    elif error.code in {"unknown_provider", "invalid_provider"}:
        code = EXIT_INVALID_PROVIDER
    elif error.stage in {ConnectionStage.SERVICE, ConnectionStage.CATALOG}:
        code = EXIT_SERVICE
    else:
        code = EXIT_AUTH
    raise typer.Exit(code)


@connections_app.command("list")
def list_connections_cmd(
    json_output: Annotated[bool, typer.Option("--json", help="Emit one JSON object.")] = False,
    project: Annotated[
        str,
        typer.Option("--project", help="Project id — adds its API-key credentials."),
    ] = "",
) -> None:
    """Every connection this box has: OAuth grants, API keys, FlowPad, harnesses.

    Machine-level kinds always. API-key credentials are identified by
    ``(project_id, env_var)``, so they appear only with ``--project`` — without
    one the list is honestly smaller rather than quietly guessing which project
    you meant.
    """
    try:
        specs = _run(list_connections(project))
    except ConnectionConnectError as error:
        _error_exit(error, json_output=json_output)
        return
    if json_output:
        typer.echo(
            json.dumps(
                {
                    "ok": True,
                    "connections": [row.model_dump(mode="json") for row in specs],
                }
            )
        )
        return

    for row in specs:
        # The state word, not the boolean: "unknown" is a real answer for a
        # harness login and "not connected" would be a false one.
        typer.echo(f"{row.provider}\t{row.kind}\t{row.state}\t{row.display_name}")


@connections_app.command("connect")
def connect_connection(
    provider: Annotated[str, typer.Argument(help="Canonical provider id from `flow connections list`.")],
    json_output: Annotated[bool, typer.Option("--json", help="Emit machine-readable errors.")] = False,
) -> None:
    try:
        result = _run(connect_provider(provider, _CliPresenter()))
    except ConnectionConnectError as error:
        _error_exit(error, json_output=json_output)
        return

    typer.echo(
        json.dumps(
            {
                "ok": True,
                "provider": result.spec.provider,
                "connected": True,
                "identity": result.test.identity or result.spec.identity,
            }
        )
    )


EXIT_NOT_CONNECTED = 1


@connections_app.command("test")
def test_connection(
    provider: Annotated[str, typer.Argument(help="Canonical provider id from `flow connections list`.")],
    scope: Annotated[
        list[str],
        typer.Option("--scope", help="A scope the grant must cover. Repeatable."),
    ] = [],  # noqa: B006 — typer reads the default, never mutates it
    json_output: Annotated[bool, typer.Option("--json", help="Emit one JSON object.")] = False,
) -> None:
    """Exit 0 when ``provider`` is connected, its test passes, and its grant covers every ``--scope``.

    The completion check of a setup step: it prints no token, only the verdict.
    """
    from flow_sdk.core.connections import test as test_provider  # noqa: PLC0415

    try:
        result = _run(test_provider(provider))
        rows = _run(list_connections("")) if scope else []
    except ConnectionConnectError as error:
        _error_exit(error, json_output=json_output)
        return
    granted = next((set(r.scopes) for r in rows if r.provider.lower() == provider.strip().lower()), set())
    missing = [s for s in dict.fromkeys(scope) if s not in granted] if scope else []
    ok = bool(result.ok) and not missing
    payload = {"ok": ok, "provider": provider, "identity": result.identity, "missing_scopes": missing,
               "detail": result.detail}
    if json_output:
        typer.echo(json.dumps(payload))
    else:
        verdict = "connected" if ok else ("missing scopes: " + ", ".join(missing) if missing else "not connected")
        typer.echo(f"{provider}: {verdict}" + (f" ({result.identity})" if ok and result.identity else ""))
    if not ok:
        raise typer.Exit(EXIT_NOT_CONNECTED)
