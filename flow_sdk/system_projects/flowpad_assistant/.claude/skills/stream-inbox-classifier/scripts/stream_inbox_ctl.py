"""stream-inbox-classifier mechanics: the conversations of a window, one conversation, the tag tree, the value check.

Run with the worker's own interpreter -- ``"$FLOWPAD_PYTHON" <skill>/scripts/stream_inbox_ctl.py <verb> ...``.
Every call goes to THIS instance's backend through the ``flow`` CLI's gate-safe transport.
Output: one JSON object, ``{"ok": true, ...}`` or ``{"ok": false, "error": ...}`` with exit 1. Nothing is tagged.

  conversations [--since DATE] [--until DATE]   the conversations whose latest message is in the window
  conversation ID [--last N]                    one conversation as an agent reads it: its latest message's id,
                                                the tags it carries, and its newest N messages (default 12)
  tree                                          every tag under the classification root, with its meaning
  check FILE                                    would FILE fit `stream_inbox.classification` and today's tag tree?
                                                {fits, errors}
  submit FILE                                   hand the value in: {fits, errors, ref} -- `ref` is what a run returns
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any


def _call(method: str, path: str, body: Any = None) -> Any:
    from flow_sdk.cli.commands._common import bad_response_message, discover_port, local_request  # noqa: PLC0415

    resp = local_request(method, f"http://127.0.0.1:{discover_port()}/api/v1{path}", json=body if method != "GET" else None, timeout=60)
    try:
        envelope = resp.json() or {}
    except ValueError:
        raise RuntimeError(bad_response_message(resp)) from None
    if resp.status_code >= 400 or str(envelope.get("status")).lower() == "fail":
        raise RuntimeError(f"HTTP {resp.status_code}: {envelope.get('message') or resp.reason} {json.dumps(envelope.get('data'))[:1500]}")
    return envelope.get("data")


def _root() -> str:
    return (_call("GET", "/graph/flow_message/classification-settings") or {}).get("root") or "stream_inbox"


def _tree(root: str) -> list[dict]:
    tags = [t for t in _call("GET", "/graph/tag") or [] if not t.get("deprecated") and not t.get("system")]
    return sorted(({"name": t["name"], "meaning": t.get("description") or "", "color": t.get("color")}
                   for t in tags if str(t.get("name", "")).startswith(root + ".")), key=lambda t: t["name"])


def cmd_conversations(args) -> dict:
    """A day bound is inclusive: ``--until 2026-11-14`` takes the whole 14th."""
    since, until = args.since or "", (args.until + "T99") if args.until and len(args.until) == 10 else (args.until or "~")
    rows = [c for c in (_call("POST", "/graph/conversation-list", {}) or {}).get("conversations") or []
            if since <= (c.get("updated_date") or "") <= until and not c.get("archived")]
    rows.sort(key=lambda c: c.get("updated_date") or "")
    return {"total": len(rows), "conversations": [{"id": c["id"], "title": c.get("title") or "", "channel": c.get("channel"),
                                                    "messages": c.get("message_count"), "latest": c.get("updated_date")} for c in rows]}


def cmd_conversation(args) -> dict:
    data = _call("POST", "/graph/conversation-transcript", {"conversation_id": args.id, "last": args.last})
    messages = data.get("messages") or []
    if not messages:
        raise RuntimeError(f"conversation {args.id} has no messages")
    latest = messages[-1]
    carried = (_call("GET", f"/graph/flow_message/{latest['id']}") or {}).get("tags") or []
    root = _root()
    return {"conversation_id": data.get("id") or args.id, "message_id": latest["id"], "title": data.get("title") or "",
            "before": [t for t in carried if t.startswith(root + ".")], "message_count": data.get("message_count"),
            "messages": [{"ts": m.get("ts"), "from": m.get("from") or m.get("sender"), "text": (m.get("text") or "")[:4000]} for m in messages]}


def cmd_tree(args) -> dict:
    root = _root()
    return {"root": root, "tags": _tree(root)}


def _hand_in(path: str, dry: bool) -> dict:
    value = json.loads(Path(path).read_text(encoding="utf-8"))
    answer = _call("POST", "/graph/flow_message/stream-inbox-classification", {"value": value, "dry": dry}) or {}
    return {**answer, "conversations": len(value.get("conversations") or []), "tree_changes": len(value.get("tree_changes") or [])}


def cmd_check(args) -> dict:
    return _hand_in(args.file, dry=True)


def cmd_submit(args) -> dict:
    return _hand_in(args.file, dry=False)


VERBS = {
    "conversations": (cmd_conversations, [("--since", {}), ("--until", {})]),
    "conversation": (cmd_conversation, [("id", {}), ("--last", {"type": int, "default": 12})]),
    "tree": (cmd_tree, []),
    "check": (cmd_check, [("file", {})]),
    "submit": (cmd_submit, [("file", {})]),
}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    subs = parser.add_subparsers(dest="verb", required=True)
    for name, (_fn, params) in VERBS.items():
        sub = subs.add_parser(name)
        for flag, kwargs in params:
            sub.add_argument(flag, **kwargs)
    args = parser.parse_args(argv)
    try:
        payload = VERBS[args.verb][0](args)
    except Exception as exc:  # noqa: BLE001 -- the contract is one JSON object, always
        print(json.dumps({"ok": False, "error_code": type(exc).__name__, "error": str(exc)}))  # noqa: T201
        return 1
    print(json.dumps({"ok": True, **payload}, default=str, ensure_ascii=False))  # noqa: T201 -- the contract IS stdout
    return 0


if __name__ == "__main__":
    sys.exit(main())
