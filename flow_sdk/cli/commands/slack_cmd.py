"""``flow slack`` — read Slack with this machine's own Slack connection (the token never leaves it)."""

from __future__ import annotations

import typer

from flow_sdk.cli.commands.connections_cmd import slack_recent_cmd

slack_app = typer.Typer(
    name="slack",
    help="Read Slack: `flow slack recent --hours 24` — what happened in the channels you are in.",
    add_completion=False,
    no_args_is_help=True,
)
slack_app.command("recent")(slack_recent_cmd)
