#!/usr/bin/env python3
"""Test harness for the desktop notification service (banner + attention +
toast; the OS badge is separate state driven by ``InboxManager.unread``).

The payload is GENERIC (``{title, body, icon?, click_target?, attention?}``) —
any feature can notify; ``--type`` is a tag, never a rendering dispatch.

    # 1. Offline: assert the generic broadcast frame shape (no server; needs uv).
    uv run python scripts/test_desktop_notify.py frame

    # 2. Live: POST the `desktop-notify` action to a RUNNING backend a window
    #    is connected to (stdlib only — plain `python` is fine).
    python scripts/test_desktop_notify.py inject --title "Alice" --body "hey there"
    python scripts/test_desktop_notify.py inject --count 3 --delay 1.5

    # message-style with a conversation deep link (banner click → open + scroll):
    python scripts/test_desktop_notify.py inject --title "Alice" --body "hi" \
        --conversation <CONV_ID> --message <FM_ID>

    # any OTHER consumer — e.g. a completed process (proves the generic layer):
    python scripts/test_desktop_notify.py inject --type process_complete \
        --title "Task finished" --body "build ok" --click-view shell --click-pointer <PROC_ID>

    # 3. Print the manual observation checklist.
    python scripts/test_desktop_notify.py scenarios

Port resolution for `inject` (first hit wins): --port N | --instance NAME |
$FLOW_INSTANCE | instance "prod" (falls back to 9007).
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path


# ── port resolution ──────────────────────────────────────────────────────────
def resolve_port(args: argparse.Namespace) -> int:
    if getattr(args, "port", None):
        return int(args.port)
    instance = getattr(args, "instance", None) or os.environ.get("FLOW_INSTANCE") or "prod"
    server_json = Path.home() / ".flow" / "instances" / instance / "server.json"
    if server_json.exists():
        try:
            return int(json.loads(server_json.read_text())["port"])
        except Exception as err:  # noqa: BLE001
            print(f"! could not read port from {server_json}: {err}", file=sys.stderr)
    print(f"! no server.json for instance '{instance}', defaulting to 9007", file=sys.stderr)
    return 9007


def backend_base(args: argparse.Namespace) -> str:
    return f"http://localhost:{resolve_port(args)}"


# ── scenario 1: offline frame-shape check ────────────────────────────────────
def cmd_frame(_args: argparse.Namespace) -> int:
    import asyncio

    import flow_sdk.server.routes.websocket as ws
    from flow_sdk.notifications import notify_desktop

    captured: dict[str, str] = {}

    async def fake_broadcast(message: str) -> None:
        captured["msg"] = message

    # The notification service references websocket.broadcast late, so patching
    # the transport here still intercepts the frame.
    ws.broadcast = fake_broadcast  # type: ignore[assignment]

    asyncio.run(notify_desktop(
        "process_complete",
        title="Task finished",
        body="build ok",
        click_target={"view_type": "shell", "pointer": "proc-1"},
    ))
    frame = json.loads(captured["msg"])
    checks = {
        "message_type == ui_command": frame.get("message_type") == "ui_command",
        "kind == desktop_notify": frame.get("kind") == "desktop_notify",
        "notify_type is a tag": frame.get("notify_type") == "process_complete",
        "has message_id (uuid)": bool(frame.get("message_id")),
        "generic info payload": frame.get("info") == {
            "title": "Task finished",
            "body": "build ok",
            "click_target": {"view_type": "shell", "pointer": "proc-1"},
        },
    }

    asyncio.run(notify_desktop("message", title="Alice", body="hi", attention=False))
    quiet = json.loads(captured["msg"])
    checks["attention=False rides the payload"] = quiet.get("info") == {
        "title": "Alice", "body": "hi", "attention": False,
    }

    ok = all(checks.values())
    for label, passed in checks.items():
        print(f"  [{'PASS' if passed else 'FAIL'}] {label}")
    print(json.dumps(frame, indent=2))
    print("\nFRAME OK" if ok else "\nFRAME MISMATCH")
    return 0 if ok else 1


# ── scenario 2: live injection into a running backend ────────────────────────
def _post_action(base: str, body: dict) -> tuple[int, str]:
    url = f"{base}/api/v1/graph/desktop-notify"
    req = urllib.request.Request(
        url, data=json.dumps(body).encode(), method="POST",
        headers={"Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=10) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()
    except urllib.error.URLError as err:
        return 0, f"connection failed: {err}"


def _click_target(args: argparse.Namespace) -> dict | None:
    """--click-view/--click-pointer wins; --conversation/--message is the
    message-consumer convenience that builds the same generic pointer."""
    if args.click_view:
        target: dict = {"view_type": args.click_view}
        if args.click_pointer:
            target["pointer"] = args.click_pointer
        return target
    if args.conversation:
        pointer = args.conversation + (f"/message/{args.message}" if args.message else "")
        return {"view_type": "conversation", "pointer": pointer}
    return None


def cmd_inject(args: argparse.Namespace) -> int:
    base = backend_base(args)
    print(f"→ backend {base}  (POST /api/v1/graph/desktop-notify)")
    exit_code = 0
    for i in range(args.count):
        info: dict = {
            "title": args.title,
            "body": args.body + (f" ({i + 1}/{args.count})" if args.count > 1 else ""),
        }
        target = _click_target(args)
        if target:
            info["click_target"] = target
        if args.no_attention:
            info["attention"] = False
        status, text = _post_action(base, {"type": args.type, "info": info})
        ok = status == 200
        exit_code = exit_code or (0 if ok else 1)
        print(f"  [{i + 1}/{args.count}] HTTP {status} {'OK' if ok else '✗'}  {text[:200]}")
        if not ok and status in (0, 400, 404, 422):
            print(
                "    ↳ Is the updated backend running and is the app/tab connected to THIS port?\n"
                "      (An old server process won't have the desktop-notify action registered.)"
            )
        if i + 1 < args.count:
            time.sleep(args.delay)
    if exit_code == 0:
        print("\nInjected. Watch the connected app: banner (if backgrounded), dock bounce /\n"
              "taskbar flash, and the in-app toast. The dock badge follows InboxManager.unread\n"
              "(real inbox state) — a synthetic inject does NOT move it.")
    return exit_code


# ── scenario 3: manual observation checklist ─────────────────────────────────
CHECKLIST = """\
Desktop-notification scenarios — how to run + what to observe
============================================================

Setup: run the updated app so its renderer connects to a backend on a known port.
  cd electron && npm run dev            # dev; banner may be attributed to "Electron"
  # or a signed build for true banner attribution (ai.flowpad.desktop)

1) Banner + attention (backgrounded)
   - Background the app, then:
       python scripts/test_desktop_notify.py inject --title "Alice" --body "hi"
   - OBSERVE: OS banner; dock BOUNCES (macOS) / taskbar FLASHES (Linux/Windows).

2) Banner click → generic navigation
   - Inject with a real conversation + message id:
       python scripts/test_desktop_notify.py inject --title "Alice" --body "hi" \\
           --conversation <CONV_ID> --message <FM_ID>
   - Click the banner. OBSERVE: window focuses, conversation opens, view scrolls
     to the exact message bubble.

3) Generic consumer (layer litmus, live)
   - python scripts/test_desktop_notify.py inject --type process_complete \\
         --title "Task finished" --body "build ok" --click-view shell --click-pointer <ID>
   - OBSERVE: same banner/attention/toast pipeline; click navigates to the shell
     view; NO inbox recount fires (badge/pip unchanged).

4) Badge = InboxManager.unread (state, not events)
   - Send a REAL message from a second user (scripts/instance_ctl.sh launch dev-1).
   - OBSERVE: sidebar pip AND OS dock badge move together (one reflected value),
     *before* accepting a new-contact conversation too (invitations count).
   - Accept the invitation → preview marked read → count drops. "Mark all read"
     with a pending invitation → count stays > 0 (by design).

5) Focused-app path
   - App frontmost + inject: OS suppresses the banner; no bounce/flash
     (focus-guarded); in-app toast still shows.

6) Browser fallback (no Electron)
   - Plain browser tab: in-app toast fires, pip reflects InboxManager, nothing throws.

7) No-coalesce: inject --count 3 --delay 1 → three distinct banners.

8) Self-send skip: send FROM this user → no self-notification (hub_bridge gate).

Offline (no server):
   uv run python scripts/test_desktop_notify.py frame   # generic frame shape
"""


def cmd_scenarios(_args: argparse.Namespace) -> int:
    print(CHECKLIST)
    return 0


# ── arg parsing ──────────────────────────────────────────────────────────────
def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    sub.add_parser("frame", help="offline: assert the generic broadcast frame shape (needs uv)")

    pi = sub.add_parser("inject", help="POST desktop-notify to a running backend")
    pi.add_argument("--port", type=int, help="backend port (overrides instance)")
    pi.add_argument("--instance", help="instance name (reads ~/.flow/instances/<name>/server.json)")
    pi.add_argument("--type", default="message", help="notify_type tag (default: message)")
    pi.add_argument("--title", default="Test Sender", help="banner + toast title")
    pi.add_argument("--body", default="This is a test message", help="banner + toast body")
    pi.add_argument("--click-view", help="generic click target view_type (e.g. shell, home)")
    pi.add_argument("--click-pointer", help="generic click target pointer")
    pi.add_argument("--conversation", help="convenience: conversation id for a message-style click target")
    pi.add_argument("--message", default="", help="convenience: message id appended to --conversation")
    pi.add_argument("--no-attention", action="store_true", help="suppress dock bounce / taskbar flash")
    pi.add_argument("--count", type=int, default=1, help="how many to send")
    pi.add_argument("--delay", type=float, default=1.0, help="seconds between sends")

    sub.add_parser("scenarios", help="print the manual observation checklist")
    return p


def main() -> int:
    args = build_parser().parse_args()
    return {"frame": cmd_frame, "inject": cmd_inject, "scenarios": cmd_scenarios}[args.cmd](args)


if __name__ == "__main__":
    raise SystemExit(main())
