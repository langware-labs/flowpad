"""Per-contact, per-project prompt permissions — the receiver's LOCAL policy.

A ``ContactPermission`` records what a remote contact is allowed to do with the
prompts they send into a shared conversation: auto-run them
(``execute_prompt``) and/or have the captured reply auto-sent (``auto_reply``,
otherwise the reply is saved as a draft for review).

Keyed by the contact (``contact_user_id`` — the cross-machine-stable key, since
``FlowMessage.sender_id`` is always a user id — with ``contact_email`` as a
human-stable fallback) and a project (``project_id`` None = global / all
projects). Stored locally only; this is the receiver's decision and is never
pushed to the hub.
"""
from __future__ import annotations

from typing import ClassVar, Optional

from pydantic import field_validator

from flow_sdk._compat import StrEnum
from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.builtin.user import normalize_email
from flow_sdk.core import Entity


class PermissionAction(StrEnum):
    """Capability strings stored in ``ContactPermission.allowed_actions``."""

    EXECUTE_PROMPT = "execute_prompt"  # auto-run a received prompt
    AUTO_REPLY = "auto_reply"          # send the captured reply (else draft it)


def _contact_matches(
    row: "ContactPermission",
    contact_user_id: Optional[str],
    contact_email: Optional[str],
) -> bool:
    """A row matches a contact when EITHER the user id or the (lowercased)
    email lines up — user id is preferred, email is the fallback."""
    if contact_user_id and row.contact_user_id and row.contact_user_id == contact_user_id:
        return True
    if contact_email and row.contact_email:
        return normalize_email(row.contact_email) == normalize_email(contact_email)
    return False


class ContactPermission(Entity):
    type: str = APIField(default="contact_permission")
    contact_user_id: Optional[str] = APIField(None)
    contact_email: Optional[str] = APIField(None)
    # None = global (all projects); else scoped to this local project id.
    project_id: Optional[str] = APIField(None)
    # Granted capabilities (``PermissionAction`` values).
    allowed_actions: list[str] = APIField(default_factory=list)

    @field_validator("contact_email", mode="before")
    @classmethod
    def _normalize_contact_email(cls, v):
        if v is None or isinstance(v, str):
            return normalize_email(v)
        return v

    _api_visible: ClassVar[bool] = True
    _icon: ClassVar[str | None] = "ShieldCheck"

    @property
    def display_name(self) -> str:
        who = self.contact_email or self.contact_user_id or "contact"
        scope = self.project_id or "all projects"
        return f"{who} · {scope}"

    @classmethod
    async def grants(
        cls,
        *,
        action: str,
        contact_user_id: Optional[str] = None,
        contact_email: Optional[str] = None,
        project_id: Optional[str] = None,
    ) -> bool:
        """True iff some local permission row grants ``action`` to this contact
        for this project. A project-scoped row for ``project_id`` OR a global
        row (``project_id is None``) both grant. The contact-permission table is
        the receiver's own small local policy set, so a full scan is fine."""
        if not contact_user_id and not contact_email:
            return False
        return _grants(
            await cls.get_all(),
            action=action,
            contact_user_id=contact_user_id,
            contact_email=contact_email,
            project_id=project_id,
        )


def _grants(
    rows: list["ContactPermission"],
    *,
    action: str,
    contact_user_id: Optional[str],
    contact_email: Optional[str],
    project_id: Optional[str],
) -> bool:
    """Pure permission decision over a set of rows (DB-free, unit-testable)."""
    for row in rows:
        if action not in (row.allowed_actions or []):
            continue
        if not _contact_matches(row, contact_user_id, contact_email):
            continue
        if row.project_id is None or row.project_id == project_id:
            return True
    return False
