import logging
from typing import TYPE_CHECKING, ClassVar

from fastapi import Request, Response
from pydantic import Field

from flow_sdk.config import default_service_config
from flow_sdk.flowpad_types.enums import VISITOR_AUTH_ROLE
from flow_sdk.api.api_types.api_field import APIField, EntityField, Sharing
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.request_context.methods import get_current_request_info

if TYPE_CHECKING:
    from flow_sdk.core.auth.providers.auth_provider import AuthProvider


class Visitor(Entity):
    type: str = APIField(default=BuiltinEntityType.VISITOR.value)
    ga_client_id: str | None = Field(default=None)
    utm_params: dict[str, str] | None = Field(default=None)  # Stores all utm_* query parameters
    # Not APIField, for security (stays off the API surface); PRIVATE so it
    # matches the base declaration instead of silently widening it.
    visitor_role: str = EntityField(default=VISITOR_AUTH_ROLE.value.lower(), sharing=Sharing.PRIVATE)

    @staticmethod
    def _get_ga_client_id(cookies: dict[str, str]) -> str | None:
        """Extract Google Analytics client ID from cookies."""
        ga_cookie = cookies.get("_ga")
        if not ga_cookie:
            return None
        # Example: "GA1.1.1234567890.1700000000"
        parts = ga_cookie.split(".")
        return f"{parts[-2]}.{parts[-1]}" if len(parts) == 4 else ga_cookie

    @classmethod
    async def from_request_info(cls) -> "Visitor":
        """
        Get or create visitor from current request context.

        Returns:
            Visitor instance (either existing or newly created)

        Raises:
            ValueError: If no request_info is available in the current context
        """
        request_info = get_current_request_info()
        if not request_info or not request_info.request:
            raise ValueError("No request available in current context")

        request = request_info.request
        visitor_id = request_info.visitor_typeid.id if request_info.visitor_typeid else None
        ga_client_id = cls._get_ga_client_id(request.cookies)
        utm_params = request_info.utm
        if visitor_id:
            visitor = await cls.get_by_id(visitor_id)
            if visitor:
                needs_save = False
                # Update GA client ID if missing
                if visitor.ga_client_id is None and ga_client_id:
                    visitor.ga_client_id = ga_client_id
                    needs_save = True
                # Update UTM params only if not already set (first visit wins)
                if visitor.utm_params is None and utm_params:
                    visitor.utm_params = utm_params
                    needs_save = True
                if needs_save:
                    await visitor.save()
                return visitor

        # Create new visitor if no valid visitor ID found
        visitor = cls()
        visitor.ga_client_id = ga_client_id
        visitor.utm_params = utm_params
        await visitor.save()
        return visitor

    def set_cookie(
        self,
        response: Response,
        request: Request,
        auth_provider: "AuthProvider",
        session: bool = False,
    ) -> None:
        """
        Set visitor cookie on response.

        Args:
            response: The FastAPI response object
            request: The FastAPI request object
            auth_provider: The auth provider instance
            session: If True, sets a session cookie that expires when browser closes.
                    If False (default), sets a persistent cookie that expires in 1 year.
        """
        # Check if visitor ID already exists in cookies
        visitor_id_in_cookie = request.cookies.get(default_service_config.visitor_cookie_name) or request.cookies.get(
            default_service_config.visitor_session_cookie_name
        )

        # If cookie already exists, and we're in session mode, no need to set again
        if visitor_id_in_cookie and session:
            return

        # Set cookie with appropriate expiration
        if session:
            cookie_name = default_service_config.visitor_session_cookie_name
            max_age = None
        else:
            cookie_name = default_service_config.visitor_cookie_name
            max_age = 31536000  # 1 year in seconds

        auth_provider.set_cookie(
            response,
            self.id,
            cookie_name,
            max_age=max_age,
        )
