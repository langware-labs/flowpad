import itertools
import os
from typing import ClassVar, List, Optional
from urllib.parse import urlparse, urlunparse

from fastapi import HTTPException
from pydantic import BaseModel

from flow_sdk.api.identifier import is_valid_identifier
from flow_sdk.api.type_id import TypeId
from flow_sdk.actions.action_registry import is_action
from flow_sdk.config import API_PREFIX
from flow_sdk.fs_store.schema_registry import SchemaRegistry


def make_pairs(array: list):
    it = iter(array)
    pairs = []
    for x in it:
        y = next(it, None)
        pairs.append((x, y))
    return pairs


def strip_host_from_url(url: str) -> str:
    parsed = urlparse(url)
    stripped_url = urlunparse(("", "", parsed.path, parsed.params, parsed.query, parsed.fragment))
    return stripped_url


# TODO, make the base of request_info.parse_api_path and url_service / ApiUrl
class APIRequest(BaseModel):
    _raw_api_path: Optional[str] = None

    api_prefix: ClassVar[str] = API_PREFIX
    graph_prefix: ClassVar[str] = "/graph"
    method: Optional[str] = "GET"
    scope: List[TypeId] = []
    direct_resource_type: Optional[str] = None
    target_typeid: Optional[TypeId] = None
    action: Optional[str] = None
    sub_path: Optional[str] = None
    query_params: Optional[dict] = None
    body: Optional[dict] = None

    def to_api_full_url(self, base_address: str | None = None) -> str:
        if not base_address:
            base_address = os.getenv("SERVICE_URLS_CONFIG__API_URL", None)
        if not base_address:
            raise ValueError("Base address is required in ApiUrl")
        query_part = f"?{self.query_string}" if self.query_string else ""
        return f"{base_address}{self.api_path}{query_part}"

    @property
    def api_path(self):
        _url = ""
        if self.api_prefix:
            _url += self.api_prefix
        if self.graph_prefix:
            _url += self.graph_prefix
        _url += self.graph_api_url_path
        return _url

    @property
    def graph_api_url_path(self):
        graph_path = "/".join([f"{tid.type}/{tid.id}" for tid in self.scope])
        if self.target_typeid:
            graph_path += f"/{self.target_typeid.type}/{self.target_typeid.identifier}"
        if self.direct_resource_type:
            graph_path += f"/{self.direct_resource_type}"
        elif self.action:
            graph_path += f"/{self.action}"
            if self.sub_path:
                graph_path += f"/{self.sub_path}"
        return graph_path.lower()

    @property
    def query_string(self):
        if self.query_params:
            return "&".join([f"{k}={v}" for k, v in self.query_params.items()])
        return ""

    @property
    def segments(self) -> List[str]:
        return [seg for seg in self.graph_api_url_path.strip("/").split("/") if seg]

    @property
    def raw_api_path(self):
        return self._raw_api_path

    @property
    def namesapce(self):
        if self.target_typeid and self.target_typeid.namespace:
            return self.target_typeid.namespace
        # loop scope in reverse and return first namesace that exist
        for typeid in reversed(self.scope):
            if typeid.namespace:
                return typeid.namespace
        return None

    @property
    def parent_typeid(self):
        if self.scope:
            return self.scope[-1]
        return None

    def is_graph_path(self, flowpad_path: str | None = None) -> bool:
        if not flowpad_path:
            flowpad_path = self.raw_api_path
        if not flowpad_path:
            return False
        flowpad_path = strip_host_from_url(flowpad_path)
        no_prefix_api_path = flowpad_path.removeprefix(self.api_prefix).removesuffix("/")
        return no_prefix_api_path.removeprefix("/").startswith(self.graph_prefix.removeprefix("/"))

    @classmethod
    def from_api_path(cls, api_path: str = "") -> "APIRequest":
        api_request: APIRequest = cls()
        api_request.method = "GET"

        if not api_path:
            return api_request

        api_request._raw_api_path = api_path

        if not api_request.is_graph_path(api_path):
            return api_request
        no_host_api_path = strip_host_from_url(api_path)
        no_prefix_api_path = no_host_api_path.removeprefix(cls.api_prefix).removesuffix("/")

        lower_api_path = no_prefix_api_path.lower()  # Lowercase for processing
        original_api_path = no_prefix_api_path

        # Trim the graph prefix and calculate the trimmed length
        graph_prefix = cls.graph_prefix
        if lower_api_path.startswith(graph_prefix):
            trimmed_length = len(graph_prefix)
            lower_api_path = lower_api_path[trimmed_length:]
            original_api_path = original_api_path[trimmed_length:]

        # Split into segments after trimming
        lower_case_segments = [seg for seg in lower_api_path.strip("/").split("/") if seg]
        original_segments = [seg for seg in original_api_path.strip("/").split("/") if seg]  # Retain original casing

        # Ensure alignment
        if len(original_segments) != len(lower_case_segments):
            raise ValueError("Mismatch between original and lowercased segments after prefix trimming.")

        lower_case_pairs = make_pairs(lower_case_segments)
        original_pairs = make_pairs(original_segments)

        type_map = [SchemaRegistry.is_entity_type(segment) for segment in lower_case_segments]
        for i in range(len(type_map) - 1):
            if type_map[i] and type_map[i + 1]:
                raise ValueError("Entity after entity is not allowed")

        # Process pairs to identify scoped and non-scoped pairs
        typeid_pairs_bitmap = [SchemaRegistry.is_entity_type(pair[0]) and is_valid_identifier(pair[1]) for pair in lower_case_pairs]
        scoped_typeid_pairs = []
        none_scoped_pairs = []
        for i in range(len(typeid_pairs_bitmap)):
            if typeid_pairs_bitmap[i] and not none_scoped_pairs:
                scoped_typeid_pairs.append(original_pairs[i])
            else:
                none_scoped_pairs.append(original_pairs[i])

        api_request.direct_resource_type = (
            none_scoped_pairs[0][0] if none_scoped_pairs and SchemaRegistry.is_entity_type(none_scoped_pairs[0][0]) else None
        )

        if scoped_typeid_pairs:
            target_pair = scoped_typeid_pairs.pop()
            api_request.target_typeid = TypeId(type=target_pair[0], id=target_pair[1])
            api_request.scope = [TypeId(type=pair[0], id=pair[1]) for pair in scoped_typeid_pairs]
        if none_scoped_pairs:
            non_scoped_segments = list(itertools.chain(*none_scoped_pairs))
            non_scoped_segments = list(filter(lambda x: x is not None, non_scoped_segments))
            if api_request.target_typeid and not api_request.direct_resource_type:
                api_request.action = (
                    non_scoped_segments.pop(0)
                    if is_action(non_scoped_segments[0], api_request.target_typeid.type)
                    else None
                )
                if api_request.action:
                    api_request.sub_path = (
                        "/".join([seg for seg in non_scoped_segments]) if non_scoped_segments else None
                    )
            elif is_action(non_scoped_segments[0]):
                api_request.action = non_scoped_segments.pop(0)
                api_request.sub_path = "/".join([seg for seg in non_scoped_segments]) if non_scoped_segments else None
            elif api_request.direct_resource_type:
                resource_type = non_scoped_segments.pop(0)
                assert resource_type == api_request.direct_resource_type, "Resource type mismatch"
                if non_scoped_segments:
                    if is_action(non_scoped_segments[0], resource_type):
                        api_request.action = non_scoped_segments.pop(0)
                        api_request.sub_path = (
                            "/".join([seg for seg in non_scoped_segments]) if non_scoped_segments else None
                        )
                    else:
                        raise HTTPException(
                            status_code=422,
                            detail=f"Unknown resource type or action: {non_scoped_segments[0]} for {api_request.raw_api_path}",
                        )
            else:
                raise HTTPException(
                    status_code=422,
                    detail=f"Unknown entity type or action: {non_scoped_segments[0]} for {api_request.raw_api_path}",
                )
        return api_request
