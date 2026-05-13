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
