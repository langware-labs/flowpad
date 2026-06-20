import hashlib
import logging
import random
import string
from datetime import datetime, timedelta
from flow_sdk._compat import UTC
from typing import TYPE_CHECKING, ClassVar, Optional

if TYPE_CHECKING:
    from flow_sdk.builtin.api_key import ApiKey

from fastapi import HTTPException

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.api.type_id import TypeId
from flow_sdk.builtin.visitor import Visitor
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity

char_set = string.ascii_lowercase + string.digits


def hash_password(salt: str, password: str) -> str:
    """Hash a password with the given salt using SHA256."""
    return hashlib.sha256(f"{salt}{password}".encode()).hexdigest()


class UserAlreadyExistsException(Exception):
    def __init__(self, message: str):
        self.message = message
        super().__init__(self.message)


class User(Entity):
    type: str = APIField(default=BuiltinEntityType.USER.value)
    name: str | None = APIField(None)
    picture: str | None = APIField(None)
    email: str | None = APIField(None)
    last_login: datetime | None = APIField(None)
    onboarded: bool = APIField(default=False)
    # Optional cloud organization the user belongs to (one org, hub-authoritative).
    # Set on cloud login from the hub login payload; the org itself is materialized
    # locally as a remote=True Organization at this id. Role lives on the edge here,
    # not on the shared Organization entity. Defaults to "member".
    organization_id: str | None = APIField(None)
    organization_role: str = APIField(default="member")
    salt_: str | None = None
    hashed_password_: str | None = None
    _unique: ClassVar[list[str]] = ["email"]

    def __init__(self, **data):
        super().__init__(**data)
        if not self.salt_:
            self.salt_ = str("".join(random.sample(char_set * 6, 10)))

    def hash_password(self, password: str):
        if not self.salt_:
            raise ValueError("Salt not set")
        self.hashed_password_ = hash_password(salt=self.salt_, password=password)

    def api_user(self) -> "User":
        """Return a sanitized copy of the user without sensitive fields"""
        self.salt_ = None
        self.hashed_password_ = None
        return self

    def to_participant(self, override_name: str | None = None) -> dict:
        name = override_name.strip() if override_name and override_name.strip() else (self.name or self.email or "")
        return {
            "user_id": self.id or "",
            "name": name,
            "email": self.email or "",
        }

    @classmethod
    async def current_sender_participant(cls, override_name: str | None = None) -> dict:
        override = override_name.strip() if override_name and override_name.strip() else ""
        try:
            from flow_sdk.cli.app_config import get_user
            from flow_sdk.cli.auth.hub_login import is_logged_in

            if is_logged_in():
                cloud_user = get_user()
                if isinstance(cloud_user, dict) and cloud_user.get("id"):
                    email = str(cloud_user.get("email") or "")
                    return {
                        "user_id": str(cloud_user.get("id") or ""),
                        "name": override or str(cloud_user.get("name") or email),
                        "email": email,
                    }
        except Exception:
            pass

        local_user = await cls.get_local()
        if local_user:
            return local_user.to_participant(override)
        return {"user_id": "", "name": override, "email": ""}

    @classmethod
    async def get_user_by_email(cls, email: str) -> "User | None":
        return await cls.get_one({"email": email})

    @classmethod
    async def get_local(cls) -> "User | None":
        """Return the singleton desktop user (uname='local'), or None.

        Bootstrap (``server/routes/bootstrap.py``) creates this row at startup
        and refreshes its ``name`` field from ``git config user.name`` on
        every server boot (unless the user manually overrode it via
        update-local-user-name).
        """
        return await cls.get_one({"uname": "local"})

    @classmethod
    async def local_sender_identity(
        cls, override_name: str | None = None
    ) -> tuple[str | None, str]:
        """Return ``(sender_id, sender_name)`` for outbound messages.

        Single source of truth for the resolution chain used by share-task,
        ask-for-assistance, start-conversation, add-message, and
        headless replies:

        * ``sender_id`` ← local desktop user's id (None if no local user)
        * ``sender_name`` ← ``override_name.strip()`` if non-empty, else
          ``local_user.name`` (synced from ``git config user.name``), else
          ``local_user.email``, else ``""``.
        """
        local_user = await cls.get_local()
        if local_user:
            participant = local_user.to_participant(override_name)
            return participant.get("user_id") or None, participant.get("name") or ""
        return None, ""

    @classmethod
    async def get_or_create_by_email(cls, email: str, name: str | None = None) -> "User":
        existing = await cls.get_one({"email": email})
        if existing:
            if name and not existing.name:
                existing.name = name
                return await existing.save()
            return existing
        user = cls(email=email, name=name)
        await user.save()
        return user

    async def migrate_visitor_to_user(self, visitor_typeid: TypeId):
        try:
            visitor = await Visitor.get_by_typeid(visitor_typeid)
            if not visitor:
                return
            await self.attach_child(visitor.typeid)
            await visitor.save()
            children = await visitor.get_children()
            for child in children:
                await self.attach_child(child.value)
                await visitor.detach_child(child.value.typeid)
                # the chat belongs to the user now, we don't want it to be available to random visitors
                child.value.visitor_role = None
                await child.value.save()
        except Exception as e:
            logging.error(f"Error migrating visitor to user: {e}")

    async def generate_api_key(
        self,
        name: str,
        description: Optional[str] = None,
        expires_in_days: Optional[int] = None,
    ) -> tuple[str, "ApiKey"]:
        """
        Generate a new API key for this user.

        Architecture:
        - Creates ApiKey entity with double SHA256 hash
        - Full key is returned ONCE and never stored (hash is sufficient for auth)
        - No EnvVar or SOD storage needed

        Args:
            name: Friendly name for the key
            description: Optional description (stored in ApiKey entity)
            expires_in_days: Optional expiration in days

        Returns:
            tuple: (full_key, api_key_entity)
                - full_key: The complete API key (shown once, never stored)
                - api_key_entity: The created ApiKey entity

        Raises:
            HTTPException: If API key with the same name already exists for this user
        """
        from flow_sdk.builtin.api_key import ApiKey, generate_api_key

        # Check for duplicate name
        existing_keys = await ApiKey.get_all_for_entity(self.typeid)
        for key in existing_keys:
            if key.name == name and key.is_active:
                raise HTTPException(status_code=400, detail=f"API key with name '{name}' already exists")

        # Generate API key value
        env = "test" if hasattr(self, "test_mode") else "live"
        full_key, _ = generate_api_key(env)

        # Compute hash of full key for secure lookup
        key_hash = ApiKey.hash_key(full_key)

        # Calculate expiration
        expires_at = None
        if expires_in_days:
            expires_at = datetime.now(UTC) + timedelta(days=expires_in_days)

        # Create ApiKey entity with hash (full key is never stored)
        api_key_entity = ApiKey(
            name=name,
            api_key_hash=key_hash,
            bind_typeid=str(self.typeid),
            expires_at=expires_at,
            last_used_at=None,
            is_active=True,
        )
        await api_key_entity.save()

        return full_key, api_key_entity
