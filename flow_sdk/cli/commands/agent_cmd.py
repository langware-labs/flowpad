"""``flow agent deploy <agent>`` — put an agent on a machine of its own, through the running app.

    flow agent deploy researcher                     # production, on an e2b machine
    flow agent deploy researcher --environment staging

The readiness gate runs in the app: a deploy whose placement's store (the hub) lacks a value, or whose
owner has not authorized a connection it needs, is refused with each missing item and its fix — exit 1,
nothing deployed; the refusal names the deployment, so ``flow credentials use-mine <deployment>`` copies
this computer's values into it. Names only are ever printed.
"""
from __future__ import annotations

import json
from typing import NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import discover_port, fail, get_graph_json, graph_url, ok, post_graph_json
from flow_sdk.schema.data_spec.returned_value_spec import ExitCode

agent_app = typer.Typer(name="agent", help="Deploy an agent to a machine of its own.", add_completion=False, no_args_is_help=True)

#: A cloud deploy boots a machine, clones and indexes a repository and logs it in: minutes, not seconds.
DEPLOY_SECONDS = 600


def _refused(status: int, body: dict) -> NoReturn:
    data = body.get("data") or {}
    code = str(data.get("code") or "REFUSED")
    fail(int(ExitCode.NOT_YET) if code == "not_ready" else int(ExitCode.REFUSED), code, str(body.get("message") or f"HTTP {status}"), data)


def _agent_id(port: int, agent: str) -> str:
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415

    if is_valid_uuid(agent.removeprefix("agent-")):
        return agent.removeprefix("agent-")
    rows = get_graph_json(graph_url(port, "agent"), params={"filter": json.dumps({"name": agent})}, on_error=_refused)
    matches = [r for r in rows if isinstance(r, dict) and r.get("id")] if isinstance(rows, list) else []
    if len(matches) != 1:
        fail(int(ExitCode.NOT_FOUND), "NOT_FOUND", f"{len(matches)} agents named {agent!r}; pass its id")
    return str(matches[0]["id"])


@agent_app.command("deploy")
def deploy(
    agent: Annotated[str, typer.Argument(help="The agent's name or id.")],
    environment: Annotated[Optional[str], typer.Option("--environment", help="The placement's environment (default: production).")] = None,
) -> None:
    """Deploy AGENT to a machine of its own; refused (exit 1) until the placement has what it needs."""
    port = discover_port(required=True)
    agent_id = _agent_id(port, agent)
    data = post_graph_json(graph_url(port, f"agent/{agent_id}/deploy"), {"environment": environment, "provider": "e2b"},
                           timeout=DEPLOY_SECONDS, on_error=_refused)
    deployment = (data or {}).get("deployment") or {}
    ok({"agent_id": agent_id, "deployment_id": deployment.get("id"), "secrets": (data or {}).get("secrets")})
