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
    salt_: str | None = None
    hashed_password_: str | None = None
    _api_visible: ClassVar[bool] = True
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
        ask-for-assistance, start-conversation, append-conversation, and
        headless replies:

        * ``sender_id`` ← local desktop user's id (None if no local user)
        * ``sender_name`` ← ``override_name.strip()`` if non-empty, else
          ``local_user.name`` (synced from ``git config user.name``), else
          ``local_user.email``, else the synthetic ``hostname@desktop.local``
          (display-only — never used as a routing address), else ``""``.
        """
        from flow_sdk.server.routes.bootstrap import get_default_desktop_email
        local_user = await cls.get_local()
        sender_id = local_user.id if local_user else None
        if override_name and override_name.strip():
            return sender_id, override_name.strip()
        if local_user:
            return sender_id, local_user.name or local_user.email or get_default_desktop_email()
        return None, ""

    @classmethod
    async def get_or_create_by_email(cls, email: str, name: str | None = None) -> "User":
        existing = await cls.get_one({"email": email})
        if existing:
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
