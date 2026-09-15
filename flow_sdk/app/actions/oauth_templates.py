"""HTML templates for OAuth callback responses."""

from __future__ import annotations

import html
from typing import TYPE_CHECKING, Optional

from fastapi.responses import HTMLResponse

if TYPE_CHECKING:  # pragma: no cover
    from flow_sdk.core.oauth.flows import AuthFlowResult

#: Delivered: the initiating screen already confirmed it, so the window has nothing
#: to say. It closes itself (a window the app opened) and otherwise stays empty.
_CLOSE_ONLY_HTML = """<!doctype html>
<html><head><meta charset="utf-8"><meta name="color-scheme" content="light dark">
<title>FlowPad</title></head>
<body><script>window.close();</script></body></html>
"""

_CONFIRMATION_HTML = """<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>{title}</title>
<style>
  body {{ margin: 0; min-height: 100vh; display: flex; align-items: center; justify-content: center;
    font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
    background: #f6f7f9; color: #1b1f23; }}
  main {{ background: #fff; border-radius: 12px; padding: 36px 40px; max-width: 420px; text-align: center;
    box-shadow: 0 1px 3px rgba(0,0,0,.08), 0 8px 24px rgba(0,0,0,.06); }}
  .mark {{ font-size: 36px; line-height: 1; color: {color}; }}
  h1 {{ font-size: 19px; margin: 14px 0 6px; }}
  p {{ margin: 0; color: #57606a; }}
  @media (prefers-color-scheme: dark) {{
    body {{ background: #0d1117; color: #e6edf3; }}
    main {{ background: #161b22; box-shadow: none; border: 1px solid #30363d; }}
    p {{ color: #8b949e; }}
  }}
</style></head>
<body><main><div class="mark">{mark}</div><h1>{heading}</h1><p>{detail}</p></main></body></html>
"""


def landing_page(result: Optional["AuthFlowResult"], delivered: bool) -> HTMLResponse:
    """The one page a browser lands on when an authorization flow ends.

    ``delivered`` means the screen (or CLI / SDK process) that started the flow was
    told, so it is the one confirming — the window only closes. Otherwise nobody is
    left to tell, and this page is the confirmation. ``result`` is ``None`` for a flow
    this instance does not know (expired, or started before a restart).
    """
    from flow_sdk.core.oauth.flows import AuthFlowStatus  # noqa: PLC0415

    # The landing URL carries the authorization code: never cache it, never leak it
    # onward as a Referer.
    headers = {"Cache-Control": "no-store", "Referrer-Policy": "no-referrer"}
    if delivered and result is not None:
        return HTMLResponse(_CLOSE_ONLY_HTML, headers=headers)

    if result is None:
        heading, detail, mark, color, status = (
            "This sign-in request expired",
            "Start it again from FlowPad.",
            "&#9888;",
            "#d97706",
            404,
        )
    elif result.status is AuthFlowStatus.SUCCESS:
        who = f" as {result.identity}" if result.identity else ""
        heading, detail, mark, color, status = (
            f"{result.provider} connected",
            f"Connected{who}. You can close this window.",
            "&#10003;",
            "#10b981",
            200,
        )
    elif result.status is AuthFlowStatus.CANCELLED:
        heading, detail, mark, color, status = (
            f"{result.provider} was not connected",
            result.detail or "Authorization was declined.",
            "&#8212;",
            "#6b7280",
            200,
        )
    else:
        heading, detail, mark, color, status = (
            f"Could not connect {result.provider}",
            result.detail or "Something went wrong. Close this window and try again.",
            "&#9888;",
            "#ef4444",
            400,
        )
    return HTMLResponse(
        _CONFIRMATION_HTML.format(
            title=html.escape(heading),
            heading=html.escape(heading),
            detail=html.escape(detail),
            mark=mark,
            color=color,
        ),
        status_code=status,
    )
