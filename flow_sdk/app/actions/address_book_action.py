"""Address-book scan actions — reconcile contacts from existing conversations.

Two entry points, both funnelling through the ONE learner
(:func:`flow_sdk.app.actions.flow_message_action._learn_address_book` →
``User.upsert_contact``) so send / receive / refresh / conversations-tab all
agree on "the same person":

* ``POST /api/v1/graph/address-book-scan`` (rule 5) — the address-book Refresh
  button: walk every LOCAL conversation, upsert every roster member. No hub
  fetch — DB rows only.
* ``GET  /api/v1/graph/user/<id>/conversations`` (rule 6) — the contact-detail
  Conversations tab: the same scan scoped to one contact, returning that
  contact's conversations (and upserting their rosters on the way).
"""
from __future__ import annotations

import logging

from flow_sdk.actions import action
from flow_sdk.app.actions.flow_message_action import (
    _learn_normalized_participants,
    _normalize_participants,
    _participant_value,
)
from flow_sdk.builtin.conversation import Conversation
from flow_sdk.builtin.user import User
from flow_sdk.request_context.methods import get_current_request_info
from flow_sdk.responses.response import ApiFailResponse, ApiResponse, ApiSuccessResponse

logger = logging.getLogger(__name__)


def _participant_matches(participant: dict, tokens: set[str]) -> bool:
    """True when a (normalized) conversation participant refers to a contact
    whose identity tokens are ``tokens`` (``User.identity_tokens()``) — compares
    the participant's user_id / email against the token set. ``name`` is
    intentionally excluded: it identifies a *contact* for display, not a person.
    """
    if not tokens:
        return False
    for value in (
        _participant_value(participant, "user_id"),
        _participant_value(participant, "email", "user_email"),
    ):
        if value and value.strip().lower() in tokens:
            return True
    return False


async def scan_address_book(user_tokens: set[str] | None = None) -> dict:
    """Walk every local conversation and upsert its roster into the address book.

    ``user_tokens`` scopes the scan to a single contact (rule 6): only
    conversations that contain a matching participant are learned/returned. None
    → global scan (rule 5). Returns counts plus, when scoped, the matching
    conversations as lightweight dicts for the Conversations tab.
    """
    convs = await Conversation.get_all({})
    upserted = 0
    scanned = 0
    matched: list[dict] = []
    for conv in convs or []:
        roster = list(getattr(conv, "participants", None) or [])
        if not roster:
            continue
        norm = _normalize_participants(roster)  # normalize once; reused below
        if user_tokens is not None:
            if not any(_participant_matches(p, user_tokens) for p in norm):
                continue
            matched.append(
                {
                    "id": conv.id,
                    "title": getattr(conv, "title", None),
                    "updated_date": (
                        conv.updated_date.isoformat() if getattr(conv, "updated_date", None) else None
                    ),
                }
            )
        scanned += 1
        upserted += await _learn_normalized_participants(norm)
    result = {"scanned_conversations": scanned, "upserted": upserted}
    if user_tokens is not None:
        result["conversations"] = matched
    return result


@action.post(action_name="address-book-scan", types=None)
async def address_book_scan() -> ApiResponse:
    """Rule 5 — the address-book Refresh button. Global, DB-only scan."""
    try:
        request_info = get_current_request_info()
        if not request_info or not request_info.someone_typeid:
            return ApiFailResponse(message="Authentication required")
        data = await scan_address_book()
        return ApiSuccessResponse(data=data)
    except Exception as e:  # noqa: BLE001
        logger.error("[address_book_action] scan error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")


@action.get(action_name="conversations", types=["user"])
async def user_conversations(self: User) -> ApiResponse:
    """Rule 6 — the contact-detail Conversations tab. Runs the SAME scan scoped
    to this contact: upserts the rosters of the contact's conversations and
    returns those conversations."""
    try:
        data = await scan_address_book(user_tokens=self.identity_tokens())
        return ApiSuccessResponse(data=data.get("conversations", []))
    except Exception as e:  # noqa: BLE001
        logger.error("[address_book_action] user_conversations error: %s", e, exc_info=True)
        return ApiFailResponse(message=f"Failed: {e}")
