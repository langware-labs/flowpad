import logging
import hashlib
import secrets
import string
from datetime import datetime
from typing import ClassVar, List, Optional

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.core import Entity, action
from flow_sdk.core.entity import Entity as EntityBase
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse


def generate_api_key(env: str = "live") -> tuple[str, str]:
    """
    Generate API key and return (full_key, prefix)

    Args:
        env: Environment prefix ("live" or "test")

    Returns:
        tuple: (full_key, prefix)
            - full_key: "fp_live_x7k2m9pqr3s4t5u6v7w8x9y0" (32 chars)
            - prefix: "fp_live_x7k2" (12 chars)
    """
    alphabet = string.ascii_lowercase + string.digits
    random_part = "".join(secrets.choice(alphabet) for _ in range(24))

    full_key = f"fp_{env}_{random_part}"
    prefix = full_key[:12]

    return full_key, prefix


def api_key_hash(key: str) -> str:
    """
    Compute double SHA256 hash of API key for secure storage and lookup.

    Args:
        key: Full API key string (e.g., "fp_live_x7k2m9pqr3s4t5u6v7w8x9y0")

    Returns:
        Hex string of double SHA256 hash
    """
    first_hash = hashlib.sha256(key.encode()).digest()
    second_hash = hashlib.sha256(first_hash).hexdigest()
    return second_hash


class ApiKey(Entity):
    """
    ApiKey entity representing an API key for authentication.

    Architecture:
    - Stores API key metadata (hash, expiration, usage tracking)
    - Hash computed via double SHA256 for secure one-way verification
    - Full key shown ONCE at creation, never stored (hash is sufficient for auth)
    - bind_typeid specifies which entity the key acts on behalf of
    - Lookup via get_by_hash() provides O(1) authentication
    - No EnvVar or SOD storage needed - hash comparison is sufficient
    """

    # API Key prefix constants
    KEY_PREFIX: ClassVar[str] = "fp_live_"
    DEV_KEY_PREFIX: ClassVar[str] = "fp_test_"

    type: str = APIField(default=BuiltinEntityType.API_KEY.value)
    name: str | None = APIField(None)  # Friendly name
    api_key_hash: str = APIField(...)  # Double SHA256 hash for secure lookup
    bind_typeid: str = APIField(...)  # Entity this key acts on behalf of
    expires_at: Optional[datetime] = APIField(None)
    last_used_at: Optional[datetime] = APIField(None)
    is_active: bool = APIField(default=True)
    allowed_ip_hashes: List[str] = APIField(default_factory=list)
    allowed_machine_id_hashes: List[str] = APIField(default_factory=list)

    # Private cache for binded entity
    _binded_entity: Optional[Entity] = None

    async def get_binded_entity(self) -> Optional[Entity]:
        """
        Get the entity this API key is bound to (cached).

        Returns:
            The bound entity or None if not found
        """
        if self._binded_entity is not None:
            return self._binded_entity

        bind_typeid = TypeId(self.bind_typeid)
        self._binded_entity = await Entity.get_by_typeid(bind_typeid)
        return self._binded_entity

    @classmethod
    async def get_by_hash(cls, key_hash: str) -> Optional["ApiKey"]:
        """
        Get ApiKey by hash (one-shot lookup).

        Args:
            key_hash: Double SHA256 hash of the API key

        Returns:
            ApiKey entity if found and active, None otherwise
        """
        results = await cls.get_all(entities_filter={"api_key_hash": key_hash})
        if not results or len(results) == 0:
            return None
        return results[0]

    @classmethod
    async def get_all_for_entity(cls, bind_typeid: str | TypeId) -> List["ApiKey"]:
        """
        Get all API keys bound to a specific entity.

        Args:
            bind_typeid: The TypeId of the entity (as string or TypeId object)

        Returns:
            List of ApiKey entities bound to the entity
        """
        typeid_str = str(bind_typeid)
        results = await cls.get_all(entities_filter={"bind_typeid": typeid_str})
        return results or []

    @classmethod
    def hash_key(cls, key: str) -> str:
        """
        Compute double SHA256 hash of API key.

        Args:
            key: Full API key string

        Returns:
            Hex string of double SHA256 hash
        """
        return api_key_hash(key)

    @staticmethod
    def mask_key(full_key: str) -> str:
        """
        Create masked version of API key for display.

        Args:
            full_key: The full API key string

        Returns:
            Masked string showing only last 4 characters (e.g., "****abcd")
        """
        if len(full_key) <= 4:
            return "****"
        return f"****{full_key[-4:]}"

    @classmethod
    def is_key(cls, token: str) -> bool:
        """
        Check if a token is a valid API key.

        For dev keys (fp_test_), validates that we're in dev mode.

        Args:
            token: Token to check

        Returns:
            True if token is a valid API key format and environment matches
        """
        from flow_sdk.config import default_service_config

        if token.startswith(cls.KEY_PREFIX):
            # Production key - always valid
            return True

        if token.startswith(cls.DEV_KEY_PREFIX):
            # Dev key - only valid in dev/local mode
            return default_service_config.is_local_or_development

        return False

    def add_ip(self, raw_ip: str) -> bool:
        """
        Add an IP address to the whitelist (hashes it before storage).

        Args:
            raw_ip: Raw IP address string

        Returns:
            True if added, False if already exists
        """
        ip_hash = api_key_hash(raw_ip)
        if ip_hash not in self.allowed_ip_hashes:
            self.allowed_ip_hashes.append(ip_hash)
            return True
        return False

    def remove_ip(self, raw_ip: str) -> bool:
        """
        Remove an IP address from the whitelist.

        Args:
            raw_ip: Raw IP address string

        Returns:
            True if removed, False if not found
        """
        ip_hash = api_key_hash(raw_ip)
        if ip_hash in self.allowed_ip_hashes:
            self.allowed_ip_hashes.remove(ip_hash)
            return True
        return False

    def add_machine_id(self, raw_machine_id: str) -> bool:
        """
        Add a machine ID to the whitelist (hashes it before storage).

        Args:
            raw_machine_id: Raw machine ID string

        Returns:
            True if added, False if already exists
        """
        machine_hash = api_key_hash(raw_machine_id)
        if machine_hash not in self.allowed_machine_id_hashes:
            self.allowed_machine_id_hashes.append(machine_hash)
            return True
        return False

    def remove_machine_id(self, raw_machine_id: str) -> bool:
        """
        Remove a machine ID from the whitelist.

        Args:
            raw_machine_id: Raw machine ID string

        Returns:
            True if removed, False if not found
        """
        machine_hash = api_key_hash(raw_machine_id)
        if machine_hash in self.allowed_machine_id_hashes:
            self.allowed_machine_id_hashes.remove(machine_hash)
            return True
        return False

    def validate_ip(self, raw_ip: str) -> bool:
        """
        Validate if an IP is allowed.

        Args:
            raw_ip: Raw IP address string

        Returns:
            True if whitelist is empty (all allowed) or IP is in whitelist
        """
        if not self.allowed_ip_hashes:
            return True
        ip_hash = api_key_hash(raw_ip)
        return ip_hash in self.allowed_ip_hashes

    def validate_machine_id(self, raw_machine_id: str | None) -> bool:
        """
        Validate if a machine ID is allowed.

        Args:
            raw_machine_id: Raw machine ID string or None

        Returns:
            True if whitelist is empty (all allowed) or machine ID is in whitelist
        """
        if not self.allowed_machine_id_hashes:
            return True
        if not raw_machine_id:
            return False  # Whitelist exists but no machine ID provided
        machine_hash = api_key_hash(raw_machine_id)
        return machine_hash in self.allowed_machine_id_hashes

    async def save(self, someone_typeid: TypeId | None = None, notify: bool = True):
        """
        Save API key and invalidate caches.

        When API key is saved (especially when is_active changes), invalidate:
        1. Entity cache - so fresh version is loaded next time
        2. Authorization cache - so cached auth results are re-evaluated

        Args:
            someone_typeid: Entity saving this API key

        Returns:
            Saved ApiKey entity
        """
        # Call parent save
        result = await super().save(someone_typeid, notify=notify)

        # Invalidate entity cache so fresh version is loaded on next access
        from flow_sdk.core.cache.entity_cache import entity_cache

        entity_cache.remove(str(self.typeid))

        # Auth cache invalidation is a no-op in desktop mode (no auth enforcement)

        return result


@action.all(action_name="api-keys", methods=["get", "post", "delete"], types="all")
async def api_keys_action() -> ApiResponse:
    """Stub action for API key management.

    GET: List all API keys (masked)
    POST: Create a new API key
    DELETE: Deactivate an API key

    In desktop mode, API keys are not enforced but the action exists
    for API wire compatibility.
    """
    request_info = get_current_request_info()
    if not request_info or not request_info.request:
        return ApiFailResponse(message="No request info available")

    method = request_info.request.method.upper()

    if method == "GET":
        # List all API keys (with masked values)
        try:
            keys = await ApiKey.get_all()
            if not keys:
                return ApiSuccessResponse(data=[])
            result = []
            for key in keys:
                result.append({
                    "id": key.id,
                    "name": key.name,
                    "bind_typeid": key.bind_typeid,
                    "is_active": key.is_active,
                    "expires_at": str(key.expires_at) if key.expires_at else None,
                    "last_used_at": str(key.last_used_at) if key.last_used_at else None,
                })
            return ApiSuccessResponse(data=result)
        except Exception as e:
            logging.exception(f"api-keys list error: {e}")
            return ApiFailResponse(message=str(e))

    elif method == "POST":
        # Create a new API key
        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            name = body.get("name", "api_key")
            bind_typeid = body.get("bind_typeid")
            if not bind_typeid:
                return ApiFailResponse(message="bind_typeid is required")

            env = body.get("env", "live")
            full_key, prefix = generate_api_key(env)
            key_hash = ApiKey.hash_key(full_key)

            api_key = ApiKey(
                name=name,
                api_key_hash=key_hash,
                bind_typeid=bind_typeid,
                is_active=True,
            )
            await api_key.save()

            return ApiSuccessResponse(data={
                "id": api_key.id,
                "name": api_key.name,
                "key": full_key,  # Shown ONCE at creation
                "prefix": prefix,
                "bind_typeid": api_key.bind_typeid,
            })
        except Exception as e:
            logging.exception(f"api-keys create error: {e}")
            return ApiFailResponse(message=str(e))

    elif method == "DELETE":
        # Deactivate an API key
        try:
            body = await request_info.get_post_data()
            if not isinstance(body, dict):
                return ApiFailResponse(message="Invalid request body (expected JSON object)")

            key_id = body.get("id")
            if not key_id:
                return ApiFailResponse(message="id is required")

            api_key = await ApiKey.get_by_id(key_id)
            if not api_key:
                return ApiFailResponse(message=f"API key not found: {key_id}")

            api_key.is_active = False
            await api_key.save()

            return ApiSuccessResponse(data={"id": key_id, "is_active": False})
        except Exception as e:
            logging.exception(f"api-keys delete error: {e}")
            return ApiFailResponse(message=str(e))

    return ApiFailResponse(message=f"Method {method} not supported")
