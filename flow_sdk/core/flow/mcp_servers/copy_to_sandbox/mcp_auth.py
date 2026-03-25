import uuid

from fastapi import Request
from fastapi.responses import JSONResponse
from fastmcp import FastMCP
from fastmcp.server.auth.auth import OAuthProvider
from mcp.server.auth.provider import (
    AccessToken,
    AuthorizationCode,
    AuthorizationParams,
    RefreshToken,
)
from mcp.shared.auth import OAuthClientInformationFull, OAuthToken
from pydantic import AnyHttpUrl
from pydantic_settings import BaseSettings, SettingsConfigDict


class ServerSettings(BaseSettings):
    """Settings for the MCP server that uses a token for authentication."""

    model_config = SettingsConfigDict(env_prefix="FLOWPAD_MCP_")

    # Server settings - not used but must be set
    server_url: AnyHttpUrl = AnyHttpUrl("http://localhost:8000")

    # Auth settings
    token: str

    def __init__(self, **data):
        """Initialize settings with values from environment variables."""
        super().__init__(**data)


class TokenAuthProvider(OAuthProvider):
    """Token authentication provider."""

    def __init__(self, settings: ServerSettings):
        super().__init__(
            issuer_url=settings.server_url,
            base_url=settings.server_url,
        )
        self.token = settings.token

    async def get_client(self, client_id: str) -> OAuthClientInformationFull | None:
        raise NotImplementedError

    async def register_client(self, client_info: OAuthClientInformationFull) -> None:
        raise NotImplementedError

    async def authorize(self, client: OAuthClientInformationFull, params: AuthorizationParams) -> str:
        raise NotImplementedError

    async def load_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: str
    ) -> AuthorizationCode | None:
        raise NotImplementedError

    async def exchange_authorization_code(
        self, client: OAuthClientInformationFull, authorization_code: AuthorizationCode
    ) -> OAuthToken:
        raise NotImplementedError

    async def exchange_refresh_token(
        self, client: OAuthClientInformationFull, refresh_token: RefreshToken, scopes: list[str]
    ) -> OAuthToken:
        raise NotImplementedError

    async def load_access_token(self, token: str) -> AccessToken | None:
        """Load and validate an access token."""
        if self.token != token:
            return None
        return AccessToken(token=token, client_id=str(uuid.uuid4()), scopes=[])

    async def revoke_token(self, token: AccessToken | RefreshToken) -> None:
        raise NotImplementedError


def create_mcp_server(name: str):
    """Create a FastMCP server with token authentication."""
    settings = ServerSettings()
    auth_provider = TokenAuthProvider(settings)

    mcp = FastMCP(
        name=name,
        auth=auth_provider,
    )

    # Add trailing slash to match FastMCP conventions and avoid 307 redirects
    @mcp.custom_route("/health/", methods=["GET"])
    async def health_check(request: Request):
        return JSONResponse({"status": "ok"})

    return mcp
