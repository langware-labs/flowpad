"""Local notification deep-link utilities.

handle_notification_deep_link — shared helper used by the `open` graph action
(registered in flow_sdk/app/actions/notification_action.py).

The `open` action is registered at:
  GET /api/v1/graph/notification/{id}/open
via @action.get(action_name="open", types=["notification"]).

Instead of pulling silently, this redirects to the HomeLanding page with URL
parameters so the dialog-driven flow can guide the user through pulling/cloning.
"""

import logging
from urllib.parse import urlencode

from fastapi.responses import HTMLResponse

logger = logging.getLogger(__name__)


def _get_ui_port() -> int:
    import os
    return int(os.environ.get("VITE_PORT") or os.environ.get("LOCAL_SERVER_PORT", "9007"))


_REDIRECT_HTML = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<title>FlowPad — Opening task...</title>
<style>
  *,*::before,*::after{{box-sizing:border-box}}
  html,body{{margin:0;padding:0}}
  body{{
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;
    background:#f5f4ff;
    color:#1a1a2e;
    line-height:1.6;
    min-height:100vh;
    display:flex;
    flex-direction:column;
  }}
  .nl-header{{
    background:#4f46e5;
    padding:20px 32px;
    text-align:center;
  }}
  .nl-header h1{{
    color:#fff;
    font-size:20px;
    font-weight:700;
    letter-spacing:0.5px;
    margin:0;
  }}
  .nl-main{{
    flex:1;
    display:flex;
    align-items:center;
    justify-content:center;
    padding:40px 32px;
  }}
  .nl-card{{
    background:#fff;
    border-radius:10px;
    box-shadow:0 1px 4px rgba(0,0,0,0.08);
    padding:40px 32px;
    max-width:420px;
    width:100%;
    text-align:center;
  }}
  .nl-spinner{{
    width:36px;
    height:36px;
    border:3px solid #e0deff;
    border-top-color:#4f46e5;
    border-radius:50%;
    animation:nl-spin .7s linear infinite;
    margin:0 auto 20px;
  }}
  .nl-card h2{{
    font-size:18px;
    font-weight:700;
    color:#1a1a2e;
    margin:0 0 8px;
  }}
  .nl-card p{{
    font-size:14px;
    color:#555;
    margin:0;
  }}
  .nl-footer{{
    text-align:left;
    padding:0 32px 24px;
    font-size:12px;
    color:#aaa;
  }}
  .nl-footer a{{color:#aaa}}
  @keyframes nl-spin{{to{{transform:rotate(360deg)}}}}
</style>
<meta http-equiv="refresh" content="1;url={redirect_url}">
</head>
<body>
<div class="nl-header"><h1>FlowPad</h1></div>
<div class="nl-main">
  <div class="nl-card">
    <div class="nl-spinner"></div>
    <h2>Opening FlowPad...</h2>
    <p>Redirecting you to the conversation.</p>
  </div>
</div>
<div class="nl-footer">
  Sent via FlowPad &middot; <a href="https://flowpad.ai">flowpad.ai</a>
</div>
</body>
</html>"""


async def handle_notification_deep_link(
    fm_id: str,
    conversation_id: str = "",
    task_id: str = "",
    project_url: str = "",
    branch: str = "",
    repo_id: str = "",
    sender_name: str = "",
    title: str = "",
) -> HTMLResponse:
    """Redirect the browser to HomeLanding with ``action=open`` deep-link params.

    The caller (``handle_open_flow_message``) resolves the FM's
    ``conversation_id`` and ``task_id`` from the just-unpacked bundle and
    passes them in directly, so the UI can navigate without a separate
    lookup. ``fm`` is included for traceability / fallback.

    ``project_url`` (when present) is a REPO-attachment URL that triggers the
    git pull/clone dialog before navigating into the conversation.
    ``sender_name`` / ``title`` are cosmetic — shown in the brief loading
    state.
    """
    port = _get_ui_port()

    params: dict = {"action": "open"}
    if fm_id:
        params["fm"] = fm_id
    if conversation_id:
        params["conversation_id"] = conversation_id
    if task_id:
        params["task_id"] = task_id
    if project_url:
        params["project_url"] = project_url
    if branch:
        params["branch"] = branch
    if repo_id:
        params["repo_id"] = repo_id
    if sender_name:
        params["sender_name"] = sender_name
    if title:
        params["title"] = title

    redirect_url = f"http://localhost:{port}/dock/home?{urlencode(params)}"
    return HTMLResponse(content=_REDIRECT_HTML.format(redirect_url=redirect_url))
