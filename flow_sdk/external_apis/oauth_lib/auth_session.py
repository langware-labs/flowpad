import asyncio
from enum import StrEnum, auto
from typing import Any, Optional
from uuid import uuid4

import httpx
from httpx import BasicAuth

from flow_sdk.external_apis.oauth_lib.auth_responses import CodeResponse, TokenResponse
from flow_sdk.external_apis.oauth_lib.codes import generate_code_verifier
from flow_sdk.external_apis.oauth_lib.oauth_provider_config import (
    BasicAuthParams,
    OauthProviderConfig,
    OAuthRequestType,
)


class SessionStatus(StrEnum):
    NEW = auto()
    INIT = auto()
    STARTED = auto()
    CODE_RESPONSE = auto()
    CODE_GRANTED = auto()
    COMPLETED = auto()
    ERROR = auto()


class AuthSession:
    def __init__(self, config: OauthProviderConfig):
        self.id: str = str(uuid4())
        self.config: OauthProviderConfig = config
        self.state: Optional[str] = None
        self.app_redirect_base_uri: Optional[str] = None
        self.code_response: CodeResponse | None = None
        self.code_response2: dict = {}
        self.token_response: Any | None = None
        self.status: SessionStatus = SessionStatus.NEW
        self.init()

    @property
    def oauth_params(self):
        all_params = self.config.model_dump()
        all_params["redirect_uri"] = self.app_redirect_base_uri
        all_params["state"] = self.state
        extra_values = all_params.get("extras", {})
        all_params.update(extra_values)
        all_params.update(self.code_response2)
        return all_params

    @property
    def ui_login_url(self) -> str:
        all_params = self.oauth_params
        uri_params = self.config.code_request_map.map(all_params)
        if len(uri_params.keys()) == 0:
            raise ValueError("No parameters to pass to the auth URL")
        # query_string = urllib.parse.urlencode(uri_params)
        query_string = f"{'&'.join([f'{k}={v}' for k, v in uri_params.items()])}"
        login_url = f"{self.config.auth_url}?{query_string}"
        return login_url

    def init(self):
        self.state = generate_code_verifier()
        self.status = SessionStatus.INIT

    def start(self) -> str:
        self.status = SessionStatus.STARTED
        return self.ui_login_url

    def set_code_response(self, code_response: dict):
        self.code_response2 = code_response
        self.code_response = CodeResponse(data=code_response, mapping=self.config.code_response_mapping)
        if self.state is not None and self.code_response.state != self.state:
            raise ValueError(
                f"State mismatch in code response, expected:{self.state},received:{self.code_response.state}"
            )
        self.status = SessionStatus.CODE_GRANTED

    async def wait_for_status(self, status: SessionStatus, timeout=20):
        passed_time = 0
        while self.status != status:
            await asyncio.sleep(1)
            passed_time += 1
            pass  # Removed print statement
            if passed_time > timeout:
                raise Exception(f"Timeout waiting for oauth session status: {str(status)}")

    async def wait_for_code(self, timeout=20):
        await self.wait_for_status(SessionStatus.CODE_GRANTED, timeout)

    async def get_token(self) -> TokenResponse:
        if self.code_response is None:
            raise ValueError("Code not granted for session")
        token_request_data = self.config.token_request_map.map(self.oauth_params)
        # Make the POST request to Slack's oauth.v2.access endpoint
        if self.config.token_request_map.request_type == OAuthRequestType.POST:
            if self.config.token_request_map.basic_auth:
                if isinstance(self.config.token_request_map.basic_auth, BasicAuthParams):
                    user = self.oauth_params.get(self.config.token_request_map.basic_auth.user_params_name, None)
                    password = self.oauth_params.get(
                        self.config.token_request_map.basic_auth.password_params_name, None
                    )
                else:
                    user = self.config.client_id
                    password = self.config.client_secret
                auth = BasicAuth(user, password)
            else:
                auth = None
            headers = {"Accept": "application/json"}
            response = httpx.post(self.config.token_url, data=token_request_data, auth=auth, headers=headers)
        else:
            raise NotImplementedError("Only POST request type is supported")

        # Parse the JSON response
        response_data = response.json()

        if response.status_code == 200:
            # Successfully obtained the access token
            # access_token = response_data['access_token']
            # bot_user_id = response_data.get('bot_user_id')
            # team_id = response_data['team']['id']
            # Use the access token as needed
            self.token_response = response_data
            self.status = SessionStatus.COMPLETED
            return self.token_response
        else:
            # Handle the error
            pass  # Removed print statement
            self.status = SessionStatus.ERROR
            return None
