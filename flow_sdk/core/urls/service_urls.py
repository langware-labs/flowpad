from typing import Any
from urllib.parse import parse_qs, urlencode, urlparse, urlunparse

from flow_sdk.api.api_request import APIRequest
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.config import default_service_config


class ServiceUrls:
    def __init__(self, config):
        self.config = config
        self.api = self.ApiUrl(self)
        self.app = self.AppUrl(self)

    class ApiUrl(APIRequest):
        graph_api_prefix: str | None = None
        service_urls: Any = None

        def __init__(self, service_urls):
            super().__init__()
            self.graph_api_prefix = f"{self.api_prefix}{self.graph_prefix}"
            self.service_urls = service_urls

        @property
        def base_url(self):
            url_parts = (self.api_url_scheme, self.api_netloc, "", "", "", "")
            return urlunparse(url_parts)

        @property
        def api_url_scheme(self):
            return self.service_urls.config.api_url_scheme if self.service_urls.config else "http"

        @property
        def api_hostname(self):
            return self.service_urls.config.api_hostname if self.service_urls.config else "localhost"

        @property
        def api_port(self):
            return self.service_urls.config.api_port if self.service_urls.config else 9007

        @property
        def api_netloc(self):
            return self.service_urls.config.api_netloc if self.service_urls.config else "localhost:9007"

        def build_api_path(
            self,
            public_api_path,
            query_params: dict | None = None,
            *additional_segments,
        ):
            return self.service_urls.build_path(
                self.api_prefix, query_params, public_api_path.value if hasattr(public_api_path, 'value') else public_api_path, *additional_segments
            )

        def build_entity_path(
            self,
            type_id: TypeId,
            query_params: dict | None = None,
            *additional_segments,
        ):
            return self.service_urls.build_path(
                self.graph_api_prefix,
                query_params,
                type_id.type,
                type_id.identifier,
                *additional_segments,
            )

        def build_graph_path(self, path, query_params: dict | None = None, *additional_segments):
            return self.service_urls.build_path(self.graph_api_prefix, query_params, path, *additional_segments)

        def build_entity_url(
            self,
            type_id: TypeId,
            query_params: dict | None = None,
            *additional_segments,
        ):
            full_path = self.build_entity_path(type_id, query_params, *additional_segments)
            return ServiceUrls._build_url(self.base_url, full_path)

        def build_graph_url(self, path, query_params: dict | None = None, *additional_segments):
            full_path = self.build_graph_path(path, query_params, *additional_segments)
            return ServiceUrls._build_url(self.base_url, full_path)

        def build_url(self, path, query_params: dict | None = None, *additional_segments):
            full_path = self.service_urls.build_path(path, query_params, *additional_segments)
            return ServiceUrls._build_url(self.base_url, full_path)

        def is_graph_path(self, path):
            return path.startswith(self.graph_api_prefix)

    class AppUrl:
        def __init__(self, service_urls):
            self.service_urls = service_urls

        def set_app_prefix(self, prefix: str):
            if default_service_config.development:
                if self.service_urls.config:
                    self.service_urls.config.vfs_path_prefix = prefix

        @property
        def base_url(self):
            url_parts = (self.app_url_scheme, self.app_netloc, "", "", "", "")
            return urlunparse(url_parts)

        @property
        def vfs_path_prefix(self):
            path_prefix = self.service_urls.config.vfs_path_prefix if self.service_urls.config else "/"
            if not path_prefix.startswith("/"):
                return "/" + path_prefix
            return path_prefix

        @property
        def app_url_scheme(self):
            return self.service_urls.config.app_url_scheme if self.service_urls.config else "http"

        @property
        def app_hostname(self):
            return self.service_urls.config.app_hostname if self.service_urls.config else "localhost"

        @property
        def app_port(self):
            return self.service_urls.config.app_port if self.service_urls.config else 9007

        @property
        def app_netloc(self):
            return self.service_urls.config.app_netloc if self.service_urls.config else "localhost:9007"

        def build_entity_url(self, type_id: TypeId, query_params: dict | None = None, *additional_segments):
            full_path = self.service_urls.build_path(
                self.vfs_path_prefix, query_params, type_id.type, type_id.identifier, *additional_segments
            )
            return ServiceUrls._build_url(self.base_url, full_path)

        def build_url_with_prefix(self, path: str = "", query_params: dict | None = None, *additional_segments):
            full_path = self.service_urls.build_path(self.vfs_path_prefix, query_params, path, *additional_segments)
            return ServiceUrls._build_url(self.base_url, full_path)

        def build_url(self, path: str, query_params: dict | None = None, *additional_segments):
            full_path = self.service_urls.build_path(path, query_params, *additional_segments)
            return ServiceUrls._build_url(self.base_url, full_path)

    def build_path(self, base_path, query_params: dict | None = None, *additional_segments) -> str:
        if not additional_segments and not query_params:
            return base_path
        base_path_parts = urlparse(base_path)

        # Ensure no duplicate slashes and join the segments
        segments = [base_path.rstrip("/")] + [segment.strip("/") for segment in additional_segments]
        path = "/".join(segments)

        path_parts = (
            base_path_parts.scheme,
            base_path_parts.netloc,
            path,
            base_path_parts.params,
            base_path_parts.query,
            base_path_parts.fragment,
        )

        if query_params:
            query_string = self.add_query_params(path, query_params)
            path_parts = (
                base_path_parts.scheme,
                base_path_parts.netloc,
                path,
                base_path_parts.params,
                query_string,
                base_path_parts.fragment,
            )

        return urlunparse(path_parts)

    @staticmethod
    def _build_url(base_url: str, path: str) -> str:
        base_url_parsed = urlparse(base_url)
        path_parts = urlparse(path)
        url_parts = (
            base_url_parsed.scheme,
            base_url_parsed.netloc,
            path_parts.path,
            path_parts.params,
            path_parts.query,
            path_parts.fragment,
        )
        return urlunparse(url_parts)

    @staticmethod
    def add_query_params(path, query_params):
        url_parts = urlparse(path)
        existing_query = parse_qs(url_parts.query)
        if not existing_query:
            existing_query = query_params
        else:
            existing_query.update(query_params)
        query_string = urlencode(existing_query, doseq=True)
        return query_string


# Create with None config for now - minihub doesn't need complex URL config
urls_service = ServiceUrls(default_service_config.service_urls_config if hasattr(default_service_config, 'service_urls_config') else None)


# Local type → the spelling the hub still uses. `subagent` was renamed locally
# ahead of the hub (whose `BuiltinEntityType.AGENT` is still `"agent"`), and
# sharing a subagent is a live feature, so the wire keeps the old noun until the
# hub renames. Delete this map — and the `hub_wire_type` calls — in the same
# change that renames the hub's type.
_HUB_WIRE_TYPE: dict[str, str] = {"subagent": "agent"}


def hub_wire_type(local_type: str) -> str:
    """The type name to put on the wire for a hub request."""
    return _HUB_WIRE_TYPE.get(local_type, local_type)


def build_hub_url(
    target,
    *,
    action: str | None = None,
    subpath: str | None = None,
    scope: list | None = None,
) -> str:
    """Build a hub graph URL.

    target  : entity type string ("conversation") or a TypeId-like object
              (has ``.type`` and ``.id``). When it carries an id, the URL
              addresses that instance; otherwise it addresses the type root.
    action  : optional action name appended after the entity/type root.
    subpath : optional path tail appended after the action.
    scope   : optional list of TypeId-like scope prefixes (rendered ahead of
              the entity, matching the hub's ``@<type>-<id>`` scope syntax).
    """
    segments: list[str] = []
    if scope:
        for s in scope:
            t = getattr(s, "type", None) or (s.split("-", 1)[0] if isinstance(s, str) and "-" in s else None)
            i = getattr(s, "id", None) or (s.split("-", 1)[1] if isinstance(s, str) and "-" in s else None)
            if t and i:
                segments.append(f"@{t}-{i}")
            else:
                segments.append(f"@{s}")

    etype = getattr(target, "type", None) or target if isinstance(target, str) else getattr(target, "type", None)
    eid = getattr(target, "id", None)

    if not isinstance(etype, str) or not etype:
        raise ValueError(f"build_hub_url: target must have a 'type' string (got {target!r})")

    segments.append(hub_wire_type(etype))
    if eid:
        segments.append(eid)
    if action:
        segments.append(action)
    if subpath:
        segments.append(subpath.lstrip("/"))

    # Return a path relative to api_base_url (FlowpadClient prepends /api/v1
    # itself), so the result starts with /graph/...
    return f"{urls_service.api.graph_prefix}/" + "/".join(segments)
