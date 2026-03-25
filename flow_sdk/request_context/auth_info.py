from __future__ import annotations

import hashlib
from typing import Any

from pydantic import BaseModel

from flow_sdk.api.type_id import TypeId

SCOPE_HASH_LENGTH = 8

# Actions that depend on entity state and should not be cached
STATEFUL_ACTIONS = {"view", "fs", "read", "create"}


class AuthResult(BaseModel):
    allowed: bool
    reason: str | None = None
    target_roles: list[str] = []
    target_allowed_actions: list[str] = []
    target: Any | None = None
    target_auth_scopes: list[list[TypeId]] = []
    # Actor information for cache efficiency (set during store, used during extract on cache hit)
    actor_type: str | None = None  # "user", "visitor", or "apikey" - primary actor
    actor_id: str | None = None  # user.id, visitor_id, or api_key.id
    # Additional validation info for security (e.g., API key is_active status)
    api_key_id: str | None = None  # If request used an API key, store its ID for is_active validation


class AuthContext(BaseModel):
    method: str | None = None
    scope: list[TypeId] = []
    target_type: str | None = None
    target_id: str | None = None
    direct_resource_type: str | None = None
    action: str | None = None
    sub_path: str | None = None
    query_params: dict | None = None
    body: dict | None = None
    user: Any | None = None
    visitor_typeid: TypeId | None = None
    token_hash: str | None = None  # For auth caching - hash of JWT/API key

    @property
    def target_typeid(self):
        if self.target_type is None or self.target_id is None:
            return None
        return TypeId(type=self.target_type, id=self.target_id)

    @property
    def resource_type(self):
        if self.direct_resource_type:
            return self.direct_resource_type
        if self.target_typeid:
            return self.target_typeid.type
        return None

    @property
    def auth_cache_key(self) -> str | None:
        """Generate cache key for auth caching. Returns None if not cacheable."""
        if not self.token_hash:
            return None
        # Skip cache for stateful actions
        if self.action and self.action.lower() in STATEFUL_ACTIONS:
            return None

        target_type = self.target_type or self.direct_resource_type or "none"
        target_id = self.target_id or "none"
        action = self.action or "none"
        method = self.method or "none"
        scope = self.scope or []

        scope_str = ",".join(sorted([str(t) for t in scope])) if scope else ""
        scope_hash = hashlib.sha256(scope_str.encode()).hexdigest()[:SCOPE_HASH_LENGTH]

        return f"auth:ctx_{self.token_hash}:{target_type}:{target_id}:{action}:{method}:{scope_hash}"
