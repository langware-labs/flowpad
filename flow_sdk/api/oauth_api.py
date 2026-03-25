from enum import StrEnum

from pydantic import BaseModel


class OAuthAction(StrEnum):
    """OAuth action types for the oauth action handler.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/oauth_types.py
    """
    Auth = "auth"
    Callback = "callback"
    WaitCallback = "wait-callback"
    Attach = "attach"
    Detach = "detach"
    Status = "status"
    Disconnect = "disconnect"


class OAuthErrorCode(StrEnum):
    """OAuth error codes.

    Ported from FlowPad: flowpad/hub/app/actions/oauth/oauth_types.py
    """
    NO_REQUEST_CONTEXT = "no_request_context"
    USER_NOT_FOUND = "user_not_found"
    NO_TARGET_ENTITY = "no_target_entity"
    TARGET_ENTITY_NOT_FOUND = "target_entity_not_found"
    SOD_NOT_FOUND_IN_ENV_VARS = "sod_not_found_in_env_vars"
    NO_SOD_FOUND = "no_sod_found"
    SOD_NOT_FOUND = "sod_not_found"


class OauthClientRequestInfo(BaseModel):
    oauth_request_id: str
    provider: str
    auth_url: str
