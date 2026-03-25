from pydantic import BaseModel


class OauthClientRequestInfo(BaseModel):
    oauth_request_id: str
    provider: str
    auth_url: str
