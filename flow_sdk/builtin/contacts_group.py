"""ContactsGroup — a named, local address-book group of contacts.

A personal grouping of people (participant-shaped entries: ``user_id`` /
``email`` / ``name``) so the UI can add several conversation members at once
instead of one by one. Purely local (never synced to the hub) and purely
organizational: it holds participant descriptors, not links to ``User``
entities, so a member needs nothing beyond an email to belong.

CRUD is entirely generic: ``POST/GET /graph/contacts_group`` via the
catch-all graph router; no bespoke actions.
"""

from __future__ import annotations

from typing import Any

from flow_sdk.api.api_types.api_field import APIField
from flow_sdk.core import Entity
from flow_sdk.schema.types import EntityType


class ContactsGroup(Entity):
    type: str = APIField(default=EntityType.CONTACTS_GROUP.value)
    name: str = APIField("", description="Display name of the contacts group")
    contacts: list[dict[str, Any]] = APIField(
        default_factory=list,
        description="Participant-shaped members: [{user_id?, email?, name?}]",
    )
