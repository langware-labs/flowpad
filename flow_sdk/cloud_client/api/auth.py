"""Hub auth request/response models used by the desktop client."""

from __future__ import annotations

from typing import Any

from pydantic import BaseModel, Field


class LoginInfo(BaseModel):
    email: str
    password: str | None
    remember_me: bool = False
    expires_in_seconds: int | None = None


class LoginData(BaseModel):
    token: str
    refresh_token: str | None = None
    expires: float | None = None
    user: dict[str, Any] = Field(default_factory=dict)
    # Optional cloud organization the user belongs to (hub-authoritative), with
    # the user's role on it (default "member"). None when the user has no org.
    # Materialized locally as a remote=True Organization on login.
    organization: dict[str, Any] | None = None
    organization_role: str | None = None
