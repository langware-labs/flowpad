"""Local deep-link utilities.

``deep_link_redirect`` — the redirect page every ``GET <type>/<id>/open`` returns
(the generic ``open`` action in ``flow_sdk/app/actions/open_action.py``, which
asks the type's ``resolve_open`` for the params). ``message_deep_link_params``
builds those params for a message or notification.

Instead of pulling silently, this redirects to the HomeLanding page with URL
parameters so the dialog-driven flow can guide the user through pulling/cloning.
"""

import json
import logging
from urllib.parse import urlencode

from fastapi.responses import HTMLResponse

from flow_sdk.schema.data_spec.open_link_spec import OpenLinkSpec

logger = logging.getLogger(__name__)


def _get_ui_port() -> int:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    # The vite-or-api rule lives on the settings object now, so this route and
    # `flow record url` cannot disagree about where the UI is served.
    return get_instance_settings().ui_port


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


def message_deep_link_params(
    fm_id: str,
    conversation_id: str = "",
    task_id: str = "",
    git_origin: dict | str | None = None,
    sender_name: str = "",
    title: str = "",
) -> OpenLinkSpec:
    """The ``action=open`` deep link for a message or notification.

    The resolver (``open_flow_message_params``) takes the FM's
    ``conversation_id`` and ``task_id`` from the just-unpacked bundle and
    passes them in directly, so the UI can navigate without a separate
    lookup. ``fm`` is included for traceability / fallback.

    ``git_origin`` (when present) triggers the git pull/clone dialog before
    navigating into the conversation.
    ``sender_name`` / ``title`` are cosmetic — shown in the brief loading
    state. Empty values are left out of the link.
    """
    return OpenLinkSpec(
        fm=fm_id,
        conversation_id=conversation_id or None,
        task_id=task_id or None,
        git_origin=(git_origin if isinstance(git_origin, str) else json.dumps(git_origin)) if git_origin else None,
        sender_name=sender_name or None,
        title=title or None,
    )


def deep_link_redirect(link: OpenLinkSpec) -> HTMLResponse:
    """The browser page that hands the desktop UI an ``/dock/home?action=open…``
    deep link (read by ``IncomingDeepLink``). Shared by every ``open`` action
    that materializes locally first and only then sends the UI on."""
    redirect_url = f"http://localhost:{_get_ui_port()}/dock/home?{urlencode(link.to_query())}"
    return HTMLResponse(content=_REDIRECT_HTML.format(redirect_url=redirect_url))
