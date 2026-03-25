from typing import Any, List

from pydantic import BaseModel

from flow_sdk.external_apis.oauth_lib.oauth_provider_config import OAuthParamMapping, RequestParamMappingType


class MappedData(BaseModel):
    mapping: List[OAuthParamMapping] = []
    data: dict[str, Any] = {}

    def _get_token_data_property(self, key: str) -> Any:
        provider_prop_key = next(
            (x.name for x in self.mapping if x.name == key and x.mapping == RequestParamMappingType.COPY), None
        )
        if provider_prop_key is None:
            provider_prop_key = next((x.mapped_name for x in self.mapping if x.mapped_name == key), None)
        if provider_prop_key is None:
            provider_prop_key = key
        return self.data.get(provider_prop_key, None)
