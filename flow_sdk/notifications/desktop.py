"""Desktop notification service — the ONE authoritative emit.

The generic Layer-1 surface: banner + attention (dock bounce / taskbar flash)
+ in-app toast, drawn by the Electron shell / renderer from a single opaque
payload. It knows nothing about any feature domain — message arrival, a
completed process, a feed entry, … each flatten their domain into this call
(the Layer-2 consumers), and the renderer draws every payload identically.

Every emit path — the automatic message/invitation triggers AND the explicit
``desktop-notify`` action — converges here, so the payload contract is
normalized in exactly one place.
"""

from __future__ import annotations

from typing import Optional

from flow_sdk.notifications.ui_command import broadcast_ui_command


def build_desktop_payload(
    *,
    title: str,
    body: str,
    icon: Optional[str] = None,
    click_target: Optional[dict] = None,
    attention: bool = True,
) -> dict:
    """Normalize the generic desktop-notification payload — the single shape the
    renderer reads:

    * ``title`` / ``body`` — OS banner + in-app toast text.
    * ``icon`` — optional toast icon name (OS banner uses the app icon).
    * ``click_target`` — where a click navigates: a dock pointer
      ``{"view_type": ..., "pointer": ..., "options": ...}``. A structured
      pointer, never a URL (the FE builds the URL — no backend URLs in the FE).
    * ``attention`` — dock bounce (macOS) / taskbar flash (Linux/Win); the shell
      suppresses it while the window is focused. Omitted from the payload when
      true (the renderer's default), emitted only to turn it off.

    The OS *badge count* is intentionally NOT part of this payload — it is state,
    reflected from ``InboxManager.unread`` via the entity channel.
    """
    payload: dict = {"title": title, "body": body}
    if icon:
        payload["icon"] = icon
    if click_target:
        payload["click_target"] = click_target
    if not attention:
        payload["attention"] = False
    return payload


async def notify_desktop(
    notify_type: str,
    *,
    title: str,
    body: str,
    icon: Optional[str] = None,
    click_target: Optional[dict] = None,
    attention: bool = True,
) -> None:
    """Fire a desktop notification on every connected window.

    ``notify_type`` is a tag ("message" | "invitation" | "process_complete" | …)
    for the consumer's own bookkeeping — never a rendering dispatch.
    """
    await broadcast_ui_command(
        "desktop_notify",
        notify_type=notify_type,
        info=build_desktop_payload(
            title=title, body=body, icon=icon, click_target=click_target, attention=attention
        ),
    )


async def notify_desktop_raw(notify_type: str, info: dict) -> None:
    """Emit a desktop notification from an ALREADY-ASSEMBLED payload.

    The entry point for the explicit ``desktop-notify`` action, whose caller
    (frontend / agent) supplies the generic payload directly. Routed through
    :func:`build_desktop_payload` so an external payload is normalized by the
    same contract as an internal :func:`notify_desktop` call.
    """
    await notify_desktop(
        notify_type,
        title=info.get("title") or "",
        body=info.get("body") or "",
        icon=info.get("icon"),
        click_target=info.get("click_target"),
        attention=info.get("attention", True),
    )
