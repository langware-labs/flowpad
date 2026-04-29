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
  body{{font-family:-apple-system,sans-serif;display:flex;align-items:center;justify-content:center;
       height:100vh;margin:0;background:#f5f4ff;color:#1a1a2e;text-align:center}}
  .card{{background:#fff;border-radius:12px;padding:40px;box-shadow:0 2px 12px rgba(0,0,0,.1);max-width:400px}}
  h2{{font-size:20px;margin-bottom:8px}}
  p{{color:#666;font-size:14px}}
  .spinner{{width:32px;height:32px;border:3px solid #e0e0ff;border-top-color:#4f46e5;
            border-radius:50%;animation:spin .7s linear infinite;margin:16px auto}}
  @keyframes spin{{to{{transform:rotate(360deg)}}}}
</style>
<meta http-equiv="refresh" content="1;url={redirect_url}">
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h2>Opening FlowPad...</h2>
  <p>Redirecting you to the conversation.</p>
</div>
</body>
</html>"""


async def handle_notification_deep_link(
    task_id: str,
    project_url: str = "",
    branch: str = "",
    repo_id: str = "",
    sender_name: str = "",
    task_title: str = "",
) -> HTMLResponse:
    """Redirect the browser to HomeLanding with task_action=open params.

    project_url: repo URL from a REPO attachment (flow_message path) or task
                 metadata (notification path).  When empty the UI navigates
                 directly to the task without a git pull/clone dialog.
    """
    port = _get_ui_port()

    params: dict = {"task_action": "open"}
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
    if task_title:
        params["task_title"] = task_title

    redirect_url = f"http://localhost:{port}/dock/home?{urlencode(params)}"
    return HTMLResponse(content=_REDIRECT_HTML.format(redirect_url=redirect_url))
