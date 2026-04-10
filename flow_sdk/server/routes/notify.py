"""Local notification handler routes.

GET /notify
   Deep-link from flowpad.ai email landing page.
   Called when the RECIPIENT clicks "Open in FlowPad" on flowpad.ai.
   Params: project_url, task_id
   - Triggers a git pull on the matching local repo
   - Runs the notification scanner
   - Returns an HTML page that auto-redirects to the task in the UI

Registered in server/routes/__init__.py and server/app.py.
"""

import asyncio
import logging
from typing import Tuple

from fastapi import APIRouter, Request
from fastapi.responses import HTMLResponse

from flow_sdk.config import load_server_info
from flow_sdk.utils.git import find_local_repo_for_url, git_pull

logger = logging.getLogger(__name__)
router = APIRouter()


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
<meta http-equiv="refresh" content="2;url={redirect_url}">
</head>
<body>
<div class="card">
  <div class="spinner"></div>
  <h2>Opening task...</h2>
  <p>{status_message}</p>
</div>
</body>
</html>"""

_ERROR_HTML = """<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>FlowPad — Error</title>
<style>
  body{{font-family:-apple-system,sans-serif;max-width:600px;margin:80px auto;padding:0 24px;color:#333;text-align:center}}
  h2{{color:#c0392b}} a{{color:#4f46e5}}
</style>
</head>
<body>
<h2>Could not open task</h2>
<p>{error_message}</p>
<p><a href="http://localhost:{port}/">Open FlowPad</a></p>
</body>
</html>"""


async def _pull_and_scan(project_url: str) -> Tuple[bool, str]:
    """Find the local repo for project_url, git pull, then run the notification scanner."""
    repo_path = find_local_repo_for_url(project_url) if project_url else None
    if not repo_path:
        return False, f"No local clone found for {project_url}"

    pull_ok, pull_msg = await git_pull(repo_path)
    if not pull_ok:
        logger.warning("[notify] git pull did not succeed for %s: %s", repo_path, pull_msg)

    try:
        from flow_sdk.fs_records.cross_notification_scanner import scan_incoming_notifications
        from flow_sdk.builtin.user import User
        local_user = await User.get_one({"uname": "local"})
        if local_user:
            asyncio.ensure_future(scan_incoming_notifications(local_user.id))
    except Exception:
        pass

    return pull_ok, pull_msg


async def handle_notification_deep_link(project_url: str, task_id: str) -> HTMLResponse:
    """Pull the repo, scan for notifications, return a redirect HTML page."""
    port = _get_ui_port()

    if not project_url:
        return HTMLResponse(content=_ERROR_HTML.format(
            error_message="No project URL provided. Ask the sender to share the repository URL.",
            port=port,
        ), status_code=400)

    if not find_local_repo_for_url(project_url):
        return HTMLResponse(content=_ERROR_HTML.format(
            error_message=(
                f"Could not find a local clone of <code>{project_url}</code>.<br>"
                f"Clone the repository first: <code>git clone {project_url}</code>"
            ),
            port=port,
        ), status_code=404)

    pull_ok, pull_msg = await _pull_and_scan(project_url)

    if task_id:
        redirect_url = f"http://localhost:{port}/dock/tasks/task-{task_id}"
        status_message = f"Git pull: {pull_msg} — Opening task..."
    else:
        redirect_url = f"http://localhost:{port}/dock/tasks"
        status_message = f"Git pull: {pull_msg} — Opening Tasks..."

    return HTMLResponse(content=_REDIRECT_HTML.format(
        redirect_url=redirect_url, status_message=status_message,
    ))


@router.get("/notify", response_class=HTMLResponse)
async def notification_deep_link(request: Request) -> HTMLResponse:
    """Deep-link from flowpad.ai email page — pulls repo and redirects to task view."""
    return await handle_notification_deep_link(
        project_url=request.query_params.get("project_url", ""),
        task_id=request.query_params.get("task_id", ""),
    )



