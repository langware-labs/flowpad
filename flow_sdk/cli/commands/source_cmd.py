"""``flow source ...`` — data sources from the command line.

A thin HTTP caller over the SAME local-server actions the TS SDK and the UI call (mirrors
``flow conversation``); no business logic lives here.

    flow source types                                  — the data source assets this instance can run
    flow source list                                   — configured sources
    flow source create <provider> --name N [--config k=v ...] [--account-key K]
    flow source verify <id>                            — finish setup
    flow source choices <provider> <field> [--config k=v ...]
    flow source sync <id>                              — one sync cycle now, reported
    flow source items <id> [--limit N]                 — recent records
    flow source send <id> --to T --text X [--thread K] [--subject S]
    flow source reply <id> <item-id> --text X
    flow source enable|disable <id>
    flow source delete <id>

Every command prints the standard envelope: ``{"ok": true, ...}`` on stdout, or
``{"ok": false, "error_code", "error"}`` on stderr with a non-zero exit.
"""
from __future__ import annotations

from typing import Optional

import requests
import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import bad_response_message as _bad_response_message
from flow_sdk.cli.commands._common import discover_port as _discover_port
from flow_sdk.cli.commands._common import fail as _fail
from flow_sdk.cli.commands._common import local_get as _local_get
from flow_sdk.cli.commands._common import local_post as _local_post
from flow_sdk.cli.commands._common import ok as _ok

source_app = typer.Typer(name="source", help="Configure, verify, sync and message through data sources.", add_completion=False, no_args_is_help=True)

EXIT_INVALID_ARG = 2
EXIT_NOT_FOUND = 4
EXIT_CONNECTION_ERROR = 5
EXIT_ACTION_FAILED = 7

ConfigOpt = Annotated[Optional[list[str]], typer.Option("--config", "-c", help="A config field as key=value; repeat per field.")]


def _url(path: str) -> str:
    return f"http://127.0.0.1:{_discover_port()}/api/v1/graph/{path}"


def _envelope(resp: "requests.Response", *, not_found: str = ""):
    try:
        body = resp.json()
    except ValueError:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", _bad_response_message(resp))
    if resp.status_code == 404 and not_found:
        _fail(EXIT_NOT_FOUND, "NOT_FOUND", not_found)
    if resp.status_code >= 400 or body.get("status") not in ("SUCCESS", None):
        _fail(EXIT_ACTION_FAILED, str(body.get("error_code") or "ACTION_FAILED"), str(body.get("message") or body.get("detail") or f"HTTP {resp.status_code}"))
    return body.get("data") if "data" in body else body


def _call(method: str, path: str, payload: Optional[dict] = None, *, not_found: str = "", timeout: int = 120):
    url = _url(path)
    try:
        resp = _local_post(url, json=payload or {}, timeout=timeout) if method == "POST" else _local_get(url, timeout=timeout)
    except requests.exceptions.RequestException as exc:
        _fail(EXIT_CONNECTION_ERROR, "CONNECTION_ERROR", f"Cannot reach Flowpad server at {url}: {exc}")
    return _envelope(resp, not_found=not_found)


def _config(pairs: Optional[list[str]]) -> dict:
    out: dict = {}
    for pair in pairs or []:
        key, sep, value = pair.partition("=")
        if not sep or not key.strip():
            _fail(EXIT_INVALID_ARG, "INVALID_ARG", f"--config expects key=value, got {pair!r}")
        out[key.strip()] = value
    return out


def _rows(data) -> list:
    if isinstance(data, dict):
        for key in ("items", "entities", "results", "data"):
            if isinstance(data.get(key), list):
                return data[key]
    return data if isinstance(data, list) else []


def _source_action(source_id: str, action: str, payload: Optional[dict] = None, *, timeout: int = 120):
    return _call("POST", f"data_source/{source_id}/{action}", payload, not_found=f"Data source not found: {source_id}", timeout=timeout)


@source_app.command("types", help="The data source assets this instance can run, and what each can do.")
def types() -> None:
    specs = _rows(_call("GET", "data_source_spec"))
    _ok({"types": [
        {k: s.get(k) for k in ("name", "title", "kind", "sends", "load_error", "auth", "runtime")} for s in specs if isinstance(s, dict)
    ]})


@source_app.command("list", help="Configured data sources.")
def list_sources() -> None:
    rows = _rows(_call("GET", "data_source"))
    _ok({"sources": [
        {k: r.get(k) for k in ("id", "name", "provider", "status", "health", "channel", "error_detail", "last_synced_at")} for r in rows if isinstance(r, dict)
    ]})


@source_app.command("create", help="Create a data source of <provider> (a data source asset's name).")
def create(
    provider: Annotated[str, typer.Argument(help="The data source asset name, e.g. rss or slack.")],
    name: Annotated[str, typer.Option("--name", help="A display name.")] = "",
    config: ConfigOpt = None,
    account_key: Annotated[str, typer.Option("--account-key", help="Which remote account this row serves.")] = "",
    reflect: Annotated[str, typer.Option("--reflect", help="How a file source lands its files: none | copy | symlink.")] = "",
    window_days: Annotated[int, typer.Option("--window-days", help="How far back a sync reads.")] = 0,
) -> None:
    payload: dict = {"provider": provider, "name": name or provider, "config": _config(config)}
    if account_key:
        payload["account_key"] = account_key
    if reflect:
        payload["reflect"] = reflect
    if window_days:
        payload["window_days"] = window_days
    data = _call("POST", "data_source", payload)
    row = data if isinstance(data, dict) else {}
    _ok({"source": {k: row.get(k) for k in ("id", "name", "provider", "status", "health", "channel", "setup_detail")}})


@source_app.command("verify", help="Re-run setup verification (connection, then the source's own check).")
def verify(source_id: str) -> None:
    _ok({"verdict": _source_action(source_id, "verify")})


@source_app.command("choices", help="What the credential can see for one config field.")
def choices(provider: str, field: str, config: ConfigOpt = None) -> None:
    _ok({"choices": _call("POST", "data_source/choices", {"provider": provider, "field": field, "config": _config(config)})})


@source_app.command("sync", help="Run one sync cycle now and report what it wrote.")
def sync(source_id: str) -> None:
    _ok({"report": _source_action(source_id, "sync", timeout=600)})


@source_app.command("items", help="This source's records, newest first.")
def items(source_id: str, limit: Annotated[int, typer.Option("--limit")] = 20) -> None:
    _ok(_source_action(source_id, "items", {"limit": limit}))


@source_app.command("send", help="Send one message into the source's channel.")
def send(
    source_id: str,
    to: Annotated[str, typer.Option("--to", help="What the channel addresses: a chat, channel id or address.")],
    text: Annotated[str, typer.Option("--text")],
    thread: Annotated[str, typer.Option("--thread", help="The thread to post into.")] = "",
    subject: Annotated[str, typer.Option("--subject")] = "",
) -> None:
    _ok({"sent": _source_action(source_id, "send", {"to": to, "text": text, "thread_key": thread, "subject": subject}, timeout=300)})


@source_app.command("reply", help="Reply to one of this source's records.")
def reply(source_id: str, item_id: str, text: Annotated[str, typer.Option("--text")]) -> None:
    _ok({"sent": _source_action(source_id, "reply", {"item_id": item_id, "text": text}, timeout=300)})


@source_app.command("enable", help="Resume polling.")
def enable(source_id: str) -> None:
    _ok(_source_action(source_id, "set_enabled", {"enabled": True}))


@source_app.command("disable", help="Stop polling.")
def disable(source_id: str) -> None:
    _ok(_source_action(source_id, "set_enabled", {"enabled": False}))


@source_app.command("delete", help="Delete the data source row.")
def delete(source_id: str) -> None:
    _ok(_source_action(source_id, "remove"))


__all__ = ["source_app"]
