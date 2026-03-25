from enum import StrEnum, auto
from typing import Any, Dict, List, Optional
from urllib.parse import quote

from pydantic import BaseModel


class RequestParamMappingType(StrEnum):
    COPY = auto()
    SSV = auto()  # space separated values to string
    CSV = auto()
    VALUE = auto()


class AuthUIConfig(BaseModel):
    auth_url: str
    client_id: str
    scopes: List[str] = []
    state: Optional[str] = None


class OAuthParamMapping(BaseModel):
    name: str
    mapping: RequestParamMappingType = RequestParamMappingType.COPY
    url_encode: bool = False
    optional: bool = False
    mapped_name: Optional[str] = None
    value: Optional[str] = None

    def map(self, value):
        if value is None and self.optional:
            return None
        if self.mapping == RequestParamMappingType.VALUE:
            if self.value is None:
                raise ValueError(f"Missing direct value for param : {self.name}")
            return self.value
        if value is None:
            raise ValueError(f"Missing required oauth parameter {self.name}")
        if self.mapping == RequestParamMappingType.SSV:
            mapped_val = " ".join(value)
        elif self.mapping == RequestParamMappingType.CSV:
            mapped_val = ",".join(value)
        elif self.mapping == RequestParamMappingType.COPY:
            mapped_val = str(value)
        else:
            raise ValueError(f"Unsupported oauth mapping type {self.mapping}")
        if self.url_encode:
            mapped_val = quote(mapped_val, safe="")
        return mapped_val


class OAuthRequestType(StrEnum):
    POST = auto()
    GET = auto()
    BROWSER_LINK = auto()


class BasicAuthParams(BaseModel):
    user_params_name: str
    password_params_name: str


class OAuthRequestMapping(BaseModel):
    params_mappings: Optional[List[OAuthParamMapping]] = []
    request_type: OAuthRequestType = OAuthRequestType.GET
    basic_auth: Optional[BasicAuthParams | bool] = None

    def map(self, provider_params: dict) -> dict:
        params = {}
        if self.params_mappings:
            for param_mapping in self.params_mappings:
                provider_value = provider_params.get(param_mapping.name, None)
                mapped_value = param_mapping.map(provider_value)
                if mapped_value is None:
                    continue
                mapped_name = param_mapping.mapped_name or param_mapping.name
                params[mapped_name] = mapped_value
        return params


class OAuthProviderInfo(BaseModel):
    name: str
    display_name: str
    icon: Optional[str] = None


class DesktopOAuthResult(BaseModel):
    """Result of desktop OAuth success handler."""

    credentials_name: str
    access_token: str


class OauthProviderConfig(BaseModel):
    provider_name: Optional[str] = None
    auth_url: str
    token_url: str
    audience: Optional[str] = None
    revoke_url: Optional[str] = None
    client_id: str
    client_secret: str
    scopes: List[str]
    use_pkce: bool = False
    extras: Dict[str, Any] = {}
    code_request_map: OAuthRequestMapping
    code_response_mapping: List[OAuthParamMapping] = []
    token_request_map: OAuthRequestMapping
    user_credentials_key: Optional[str] = None  # "*" means take it all
    app_credentials_key: Optional[str] = None

    @property
    def user_credentials_name(self) -> str:
        if not self.provider_name:
            raise ValueError("provider_name must be set")
        provider_name_caps = self.provider_name.upper()
        return f"{provider_name_caps}_OAUTH_USER_TOKEN"

    @property
    def app_credentials_name(self) -> str:
        if not self.provider_name:
            raise ValueError("provider_name must be set")
        provider_name_caps = self.provider_name.upper()
        return f"{provider_name_caps}_OAUTH_APP_TOKEN"

    def get_user_credentials(self, token_response: dict) -> dict:
        raise NotImplementedError("User credentials not implemented")

    def get_app_credentials(self, token_response: dict) -> dict:
        raise NotImplementedError("User credentials not implemented")

    async def on_desktop_oauth_success(self, user: Any, access_token: str, foreign_key: str = "") -> DesktopOAuthResult:
        # Default implementation: use standard credentials name
        return DesktopOAuthResult(credentials_name=self.user_credentials_name, access_token=access_token)
