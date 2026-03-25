from flow_sdk.external_apis.oauth_lib.app_oauth_api import MappedData


class TokenResponse(MappedData):
    @property
    def access_token(self) -> str | None:
        return self._get_token_data_property("access_token")

    @property
    def refresh_token(self) -> str | None:
        return self._get_token_data_property("refresh_token")

    @property
    def expires(self) -> int | None:
        return self._get_token_data_property("expires")


class CodeResponse(MappedData):
    @property
    def code(self) -> str | None:
        return self._get_token_data_property("code")

    @property
    def state(self) -> str | None:
        return self._get_token_data_property("state")
