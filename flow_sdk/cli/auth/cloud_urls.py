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


def get_logout_url(return_url: str) -> str:
    """Build the cloud logout URL with ``return_url`` URL-encoded into the template."""
    template = ApiConfig.from_env().get_full_logout_url()
    return template.replace("{return_url}", quote(return_url, safe=""))
