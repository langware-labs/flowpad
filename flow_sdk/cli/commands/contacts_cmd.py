"""``flow contacts ...`` — the address book, as the UI's ContactPicker sees it.

    flow contacts list          — every known person (minus you)
    flow contacts find <text>   — people whose name / email / hub id contains <text>

A contact is a ``User`` row (``GET graph/user``, the same source as
``useContacts``). The address book can hold several rows for one person (one
learned from a roster with only a hub id, one with the email), so rows are
merged by hub ``user_id``, then email. Start a conversation with one using
``flow conversation new <email|user_id|name> "<text>"``.
"""

from __future__ import annotations

from typing import NoReturn, Optional

import typer
from typing_extensions import Annotated

from flow_sdk.cli.commands._common import discover_port, fail, get_graph_json, graph_url, ok

contacts_app = typer.Typer(
    name="contacts",
    help="List and find people in the address book (to start a conversation with).",
    add_completion=False,
    no_args_is_help=True,
)

EXIT_NOT_FOUND = 4
EXIT_ACTION_FAILED = 7


def _on_error(status: int, body: dict) -> NoReturn:
    fail(EXIT_ACTION_FAILED, str(body.get("error_code") or "ACTION_FAILED"),
         str(body.get("message") or f"HTTP {status}"))


def _me(port: int) -> Optional[str]:
    """The signed-in hub user's id, so you are not your own contact."""
    url = f"http://127.0.0.1:{port}/api/v1/cloud/status"
    data = get_graph_json(url, on_error=lambda *_: None) or {}  # type: ignore[arg-type,return-value]
    return ((data.get("user") or {}).get("id")) or None


def load_contacts(port: int) -> list[dict]:
    """Every known person, one entry each: ``{id, name, email, user_id}``."""
    rows = get_graph_json(graph_url(port, "user"), on_error=_on_error) or []
    me = _me(port)
    merged: dict[str, dict] = {}
    for u in rows:
        if u.get("system") or (me and u.get("user_id") == me):
            continue
        email = (u.get("email") or "").strip().lower() or None
        key = u.get("user_id") or email or u.get("id")
        c = merged.setdefault(key, {"id": u.get("id"), "name": None, "email": None, "user_id": u.get("user_id")})
        c["name"] = c["name"] or u.get("name")
        c["email"] = c["email"] or email
    return list(merged.values())


def match(contacts: list[dict], text: str) -> list[dict]:
    """Contacts whose name, email or hub id contains ``text`` (case-insensitive);
    an exact email or hub id wins outright."""
    q = text.strip().lower()
    exact = [c for c in contacts if q in ((c.get("email") or ""), (c.get("user_id") or "").lower())]
    if exact:
        return exact
    return [c for c in contacts if any(q in (c.get(f) or "").lower() for f in ("name", "email", "user_id"))]


@contacts_app.command("list", help="List everyone in the address book.")
def list_contacts() -> None:
    contacts = load_contacts(discover_port())
    ok({"total": len(contacts), "contacts": contacts})


@contacts_app.command("find", help="Find people whose name, email or hub id contains <text>.")
def find_contacts(text: Annotated[str, typer.Argument(help="Name, email or hub user id (or part of it).")]) -> None:
    found = match(load_contacts(discover_port()), text)
    if not found:
        fail(EXIT_NOT_FOUND, "NOT_FOUND", f"No contact matches {text!r}. Ask for their email.")
    ok({"total": len(found), "contacts": found})
