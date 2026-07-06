"""URL builders for the cloud login / logout redirect flows.

These compose ``ApiConfig`` templates with a local-callback URL and live
in the auth package because they're auth-specific. ``cloud_login.py``,
``server/routes/cloud.py``, and ``app/actions/oauth_action.py`` are the only
callers.
"""

from urllib.parse import quote

from flow_sdk.cloud_client import ApiConfig


def get_login_url(redirect_url: str) -> str:
    """Build the cloud login URL with ``redirect_url`` URL-encoded into the template."""
    template = ApiConfig.from_env().get_full_login_url()
    return template.replace("{redirect_url}", quote(redirect_url, safe=""))


def desktop_login_callback_url() -> str:
    """The local ``/auth/login_callback`` URL the cloud redirects back to,
    carrying this instance's identity as the ``instance`` query param.

    The hub uses that param to name the desktop API key
    (``desktop-cli:<instance id>``), so key rotation on login is scoped to
    THIS machine+instance and can never revoke another machine's session.
    The single construction site for the desktop callback URL — both the CLI
    browser-window flow and the UI OAuth flow must build it here so the
    param is never dropped.
    """
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415
    from flow_sdk.utils.machine_id import desktop_instance_id  # noqa: PLC0415

    settings = get_instance_settings()
    base = settings.docker_public_url or f"http://127.0.0.1:{settings.port}"
    return f"{base}/auth/login_callback?instance={desktop_instance_id()}"


def get_logout_url(return_url: str) -> str:
    """Build the cloud logout URL with ``return_url`` URL-encoded into the template."""
    template = ApiConfig.from_env().get_full_logout_url()
    return template.replace("{return_url}", quote(return_url, safe=""))
