from __future__ import annotations

import hashlib
import logging
from typing import Any, Callable, Dict, List, Optional

from fastapi import FastAPI
from starlette.requests import Request

from flow_sdk.actions.action_registry import get_action_from_method
from flow_sdk.api.api_request import APIRequest
from flow_sdk.fs_store.type_id import TypeId
from flow_sdk.config import default_service_config
from flow_sdk.core.policy import PolicyResolver
from flow_sdk.core.urls.service_urls import urls_service
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.flowpad_types.enums import ExpansionType
from flow_sdk.fs_store.schema_registry import SchemaRegistry
from flow_sdk.request_context.request_utils import align_request_typeids
from flow_sdk.request_context.transaction_handler import TransactionHandler
from flow_sdk.utils import starlett_query_brackets_to_dict

from .auth_info import AuthContext, AuthResult


class RequestInfo:
    _next_instance_index = 0

    def __init__(self):
        self.raw_api_path: str | None = None
        self.api_path: str | None = None
        self.auth_result: AuthResult | None = None
        self.target_entity_typeid: TypeId | None = None
        self.direct_resource_type: str | None = None
        self.parent_entity: TypeId | None = None
        self.segments: List[str] = []
        self.scope: List[TypeId] = []
        self.user: Any = None
        self.request_connection_id: str | None = None
        self.request_message_id: str | None = None
        self.visitor_typeid: TypeId | None = None
        self.visitor: Any | None = None
        self.namespace: str | None = None
        self.namespace_entity: Any = None
        self.token: str | None = None
        self.token_hash: str | None = None  # Pre-computed token hash for auth caching (used by WebSocket)
        self.user_foreign_key: Optional[str] = None
        self.api_key: Any = None  # Apikey entity when authenticated via API key
        self.transaction_handler: TransactionHandler | None = None
        # close transaction is a function pointer to close the session
        self.close_transaction: Optional[Callable] = None
        self.action: str | None = None
        self.sub_path: str | None = None
        # Per-call hub-reflection opt-in. Default False (do NOT reflect). Set from
        # the ``Hub-Reflect`` HTTP header, or from the ``hub_reflect`` field of a
        # ``rest_api_msg`` on the WS-REST path (see server/routes/ws_rest.py).
        self.hub_reflect: bool = False
        self.immediate_commit = False
        self.request: Request | None = None
        self.request_parameters: Dict[str, Any] = {}
        self.expand_fields: List[str] = []
        self.policies: PolicyResolver | None = None
        self.su = False
        self.super_reader = False
        self._target_entity: Any = None
        self._post_data: Any = None  # used for post data in request
        self._request_body_parsed: bool = False  # Track if body has been parsed
        self.is_api_request: bool = False
        self._lock: bool = False
        self.utm: Dict[str, str] | None = None  # UTM tracking parameters from query string
        self.instance_counter = RequestInfo._next_instance_index + 1
        RequestInfo._next_instance_index += 1

    def __str__(self):
        return f"RequestInfo: {self.__dict__}"

    @property
    def app(self) -> FastAPI | None:
        return self.request.app if self.request else None

    @property
    def service(self) -> Any | None:
        # noinspection PyUnresolvedReferences
        return self.app.state.service if self.app else None

    @property
    def auth_context(self) -> AuthContext:
        method = None
        if self.request:
            method = self.request.method.lower()
        # Get token hash for auth caching (pre-computed for WebSocket, computed here for HTTP)
        token_hash = self.token_hash
        if not token_hash and self.token:
            token_hash = hashlib.sha256(self.token.encode()).hexdigest()[:16]
        return AuthContext(
            method=method,
            scope=self.scope,
            target_id=self.target_entity_typeid.id if self.target_entity_typeid else None,
            target_type=self.target_entity_typeid.type if self.target_entity_typeid else None,
            action=self.action,
            sub_path=self.sub_path,
            query_params=self.request_parameters,
            direct_resource_type=self.direct_resource_type,
            user=self.user,
            visitor_typeid=self.visitor_typeid,
            token_hash=token_hash,
        )

    @property
    def method(self) -> str:
        if self.request is None:
            return ""
        return self.request.method.lower()

    @property
    def expand_auth_scopes(self) -> bool:
        return ExpansionType.AuthScopes.value in self.expand_fields

    @property
    def expand_permissions(self) -> bool:
        return ExpansionType.Permissions.value in self.expand_fields

    @property
    def expand_is_private(self) -> bool:
        return ExpansionType.IsPrivate.value in self.expand_fields

    @property
    def expand_blobs(self) -> bool:
        return ExpansionType.Blobs.value in self.expand_fields

    def get_param(self, name: str) -> Any:
        if not self.request_parameters:
            return None
        return self.request_parameters.get(name, None)

    async def someone(self) -> Any | None:
        if self.user is not None and self.visitor_typeid is not None:
            return self.user

        if self.user is not None:
            return self.user

        if self.visitor_typeid is not None:
            visitor_model = SchemaRegistry.get_entity_cls(BuiltinEntityType.VISITOR.value)
            return await visitor_model.get_by_typeid(self.visitor_typeid)

        return None

    @property
    def someone_typeid(self) -> TypeId | None:
        return self.user.typeid if self.user else self.visitor_typeid

    def parse_external_domain_micro_app_request(self, micro_app_id: str):
        self._lock = True
        self.target_entity_typeid = TypeId(type=BuiltinEntityType.MICRO_APP.value, id=micro_app_id)
        self.action = (
            default_service_config.micro_app_domain_config.view_action
            if default_service_config.micro_app_domain_config
            else None
        )
        self.sub_path = (self.request.url.path if self.request.url.path != "/" else None) if self.request else None

    def is_micro_app_request(self) -> bool:
        if not self.request:
            return False
        if not default_service_config.micro_app_domain_config:
            return False
        host = self.request.headers.get("x-forwarded-host") or self.request.headers.get("host") or ""
        if not host:
            return False
        is_api_prefix: bool = self.request.url.path.startswith(urls_service.api.api_prefix)
        is_app_host: bool = self.request.url.hostname == urls_service.app.app_hostname
        is_micro_app_host: bool = default_service_config.micro_app_domain_config.is_micro_app_host(host)

        return bool(not (is_api_prefix or is_app_host) or is_micro_app_host)

    def parse_micro_app_request(self):
        if not self.request:
            return
        if not default_service_config.micro_app_domain_config:
            return
        _micro_app_id = default_service_config.micro_app_domain_config.get_micro_app_id_from_host(
            self.request.headers.get("host")
        )
        if not _micro_app_id:
            return
        self.target_entity_typeid = TypeId(type=BuiltinEntityType.MICRO_APP.value, id=_micro_app_id)
        self.action = default_service_config.micro_app_domain_config.view_action

    async def parse_from_request(self, request: Request):
        if self._lock:
            raise ValueError("RequestInfo is locked and cannot be modified")
        self.request = request
        # Per-call hub-reflection opt-in (default False). The header is a local
        # routing directive only — CloudProxy strips it before forwarding to the hub.
        self.hub_reflect = request.headers.get("Hub-Reflect", "").strip().lower() in ("true", "1", "yes")
        visitor_id = request.cookies.get(default_service_config.visitor_cookie_name) or request.cookies.get(
            default_service_config.visitor_session_cookie_name
        )
        self.visitor_typeid = TypeId(type=BuiltinEntityType.VISITOR.value, id=visitor_id) if visitor_id else None
        if self.is_micro_app_request():
            self.parse_micro_app_request()
            return
        await self._parse_request_parameters(request)
        await self.parse_api_path(request.url.path)
        if not self.action:
            implicit_action = get_action_from_method(request.method)
            self.action = implicit_action
        expand = self.get_param("expand")
        if expand:
            self.expand_fields = expand.lower().split(",")

    async def _parse_request_parameters(self, request: Request):
        if self._lock:
            raise ValueError("RequestInfo is locked and cannot be modified")
        self.request_parameters = {}
        try:
            flattened_params = starlett_query_brackets_to_dict(request.query_params)
            for param in flattened_params:
                self.request_parameters[param] = flattened_params[param]
        except KeyError:  # some tests have partial requests object
            pass

        utm = {k: v for k, v in self.request_parameters.items() if k.startswith("utm_")}
        self.utm = utm if utm else None

        # Request bodies are deliberately not consumed in middleware. The graph
        # dispatcher parses them once when binding handler arguments. This also
        # lets a Git-backed remote FS request take the early CloudProxy branch
        # with its original multipart/streaming body intact.

    @property
    def api_request(self) -> APIRequest:
        if self.raw_api_path is None:
            raise ValueError("raw_api_path is not set")
        return APIRequest.from_api_path(self.raw_api_path)

    async def parse_api_path(self, api_path: str = ""):
        self.raw_api_path = api_path
        api_request = self.api_request
        self.api_path = api_path.removeprefix(urls_service.api.api_prefix).removesuffix("/")
        self.target_entity_typeid = api_request.target_typeid
        self.scope = api_request.scope
        self.direct_resource_type = api_request.direct_resource_type
        self.action = api_request.action
        self.sub_path = api_request.sub_path
        self.segments = api_request.segments
        self.namespace = api_request.namesapce
        self.is_api_request = api_request.is_graph_path()
        self.target_entity_typeid, self.scope, self.parent_entity = await align_request_typeids(
            api_request.target_typeid, api_request.scope, api_request.parent_typeid
        )

    @property
    def top_level_entity(self) -> TypeId | None:
        if self.scope:
            return self.scope[0]
        if self.target_entity_typeid:
            return self.target_entity_typeid
        if self.user and hasattr(self.user, "typeid"):
            return self.user.typeid
        return None

    @property
    def resource_type(self):
        if self.direct_resource_type:
            return self.direct_resource_type
        if self.target_entity_typeid:
            return self.target_entity_typeid.type
        return None

    @property
    def target_entity_model(self):
        if self.target_entity_typeid:
            return SchemaRegistry.get_entity_cls(self.target_entity_typeid.type)
        return None

    async def get_target_entity(self) -> Any | None:
        if self.auth_result and self.auth_result.target:
            return self.auth_result.target
        if self._target_entity:
            return self._target_entity
        if not self.target_entity_typeid:
            return None
        if not self.target_entity_model:
            return None
        target_entity = await self.target_entity_model.get_by_typeid(self.target_entity_typeid)
        self._target_entity = target_entity
        return target_entity

    async def _parse_request_body(self) -> None:
        """Parse request body once based on content type."""
        if self._request_body_parsed or not self.request:
            return

        if self.request.method not in ["POST", "PUT", "PATCH", "DELETE"]:
            self._post_data = {}
            self._request_body_parsed = True
            return

        content_type = self.request.headers.get("content-type", "")

        try:
            if "application/json" in content_type:
                self._post_data = await self.request.json()
            elif "application/x-www-form-urlencoded" in content_type:
                form = await self.request.form()
                # Convert form data to dict, handling multi-value fields
                self._post_data = {}
                for key in form.keys():
                    values = form.getlist(key)
                    self._post_data[key] = values[0] if len(values) == 1 else values
            elif "multipart/form-data" in content_type:
                form = await self.request.form()
                # For multipart, preserve UploadFile objects and handle multi-value fields
                self._post_data = {}
                for key in form.keys():
                    values = form.getlist(key)
                    self._post_data[key] = values[0] if len(values) == 1 else values
            else:
                # Try JSON as default for backward compatibility
                try:
                    self._post_data = await self.request.json()
                except Exception:
                    self._post_data = {}
        except Exception as e:
            logging.debug(f"Failed to parse request body: {e}")
            self._post_data = {}

        if self._post_data is None:
            self._post_data = {}

        self._request_body_parsed = True

    async def get_post_data(self) -> Any:
        """Get parsed POST data, parsing the body if not already done."""
        await self._parse_request_body()
        return self._post_data

    def clear_data(self):
        self.api_path = None
        self.target_entity_typeid = None
        self._target_entity = None
        self.direct_resource_type = None
        self.parent_entity = None
        self.segments = []
        self.scope = []
        self.user = None
        self.visitor_typeid = None
        self.action = None
        self.sub_path = None
        self.namespace = None
        self.namespace_entity = None
        self.token = None
        self.user_foreign_key = None
        self.request = None
        self.request_parameters = {}
        self.utm = None
