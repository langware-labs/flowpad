"""Attaching a user's OAuth credential to a project — the two-sided share.

Ported from the hub (``flowpad/hub/app/actions/oauth/oauth_attachment.py``).
Locally this used to be a pair of stubs that returned 200 and mutated nothing,
which meant ``allowed_to_use`` was never populated and the ``CONSENT_REQUIRED``
branch of ``resolve_var_status`` was structurally unreachable.

**The two-sidedness is the invariant, not an implementation detail.** Attaching
writes to both ends:

1. on the **owner** (the user), the credential's ``allowed_to_use`` gains the
   target's typeid — consent, recorded where the secret lives;
2. on the **target** (the project), a *reference* env var is minted pointing
   back at the owner (``ref_type`` + ``ref_name``).

That is what keeps the direction right: **a connection may have a secret; a
secret never carries a required connection.** The reference row lives on the
borrower; the credential row carries only a consent list. Collapsing the two
sides into one would invert it.

The value never moves. The project holds a pointer, and resolution walks back
to the user's SOD entry at execution time.
"""

from __future__ import annotations

import logging
from typing import Optional

from pydantic import BaseModel, ConfigDict

from flow_sdk.api.api_types.type_id import TypeId
from flow_sdk.api.oauth_api import OAuthErrorCode
from flow_sdk.core.entity.entity_env.env_types import EnvVar, EnvVarType
from flow_sdk.core.entity.entity_env.env_utils import build_shared_var_name
from flow_sdk.core.entity.entity_model import Entity
from flow_sdk.core.oauth import resolve_user_credentials_name
from flow_sdk.db.drivers.db_base_record import BuiltinEntityType
from flow_sdk.request_context.methods import get_current_request_info, get_current_request_user_fresh

logger = logging.getLogger(__name__)


class OAuthAttachmentResult(BaseModel):
    success: bool
    message: str
    error: Optional[str] = None
    #: Attachments left after a revoke. 0 means nothing else is using the
    #: credential — which is NOT the same as "disconnect it": detach, disconnect
    #: and delete are three separate verbs.
    remaining_attachment_count: Optional[int] = None


class RequestValidation(BaseModel):
    model_config = ConfigDict(arbitrary_types_allowed=True)
    error: Optional[OAuthAttachmentResult] = None
    user: Optional[Entity] = None
    target_entity_typeid: Optional[TypeId] = None

    @property
    def is_valid(self) -> bool:
        return self.error is None


def _failed(message: str, code: OAuthErrorCode) -> RequestValidation:
    return RequestValidation(error=OAuthAttachmentResult(success=False, message=message, error=code))


async def validate_request_context() -> RequestValidation:
    request_info = get_current_request_info()
    if not request_info:
        return _failed("No request context found", OAuthErrorCode.NO_REQUEST_CONTEXT)
    if not request_info.user:
        return _failed("Missing user in request context", OAuthErrorCode.USER_NOT_FOUND)
    if not request_info.target_entity_typeid:
        return _failed("No target entity found in request context", OAuthErrorCode.NO_TARGET_ENTITY)
    return RequestValidation(
        user=await get_current_request_user_fresh(),
        target_entity_typeid=request_info.target_entity_typeid,
    )


def _unknown_provider(provider: str) -> OAuthAttachmentResult:
    return OAuthAttachmentResult(
        success=False, message=f"Unknown OAuth provider '{provider}'", error=OAuthErrorCode.NO_SOD_FOUND
    )


async def share_var_with(
    sharing_entity: Entity,
    var_name: str,
    shared_with: TypeId | Entity,
    shared_entity_var_name: Optional[str] = None,
) -> OAuthAttachmentResult:
    """Grant ``shared_with`` use of ``sharing_entity``'s ``var_name``.

    Both sides are written — see the module docstring. Idempotent: attaching
    something already attached is a success.
    """
    if isinstance(shared_with, TypeId):
        shared_with = await Entity.get_by_typeid(shared_with)
    if not shared_with:
        return OAuthAttachmentResult(
            success=False,
            message="Target entity not found",
            error=OAuthErrorCode.TARGET_ENTITY_NOT_FOUND,
        )

    shared_var = sharing_entity.get_env_var(var_name)
    if shared_var is None:
        return OAuthAttachmentResult(
            success=False,
            message=f"SOD for provider '{var_name}' not found in {sharing_entity.type}'s env vars",
            error=OAuthErrorCode.SOD_NOT_FOUND_IN_ENV_VARS,
        )

    if shared_var.is_allowed(shared_with.typeid):
        return OAuthAttachmentResult(
            success=True, message=f"Entity already attached to SOD provider '{var_name}'"
        )

    # Side 1 — consent, recorded on the credential's owner.
    shared_var.share_with(shared_with.typeid)
    await sharing_entity.update()

    # Side 2 — a reference on the borrower, pointing back. This row is what
    # makes the borrower's env table resolve; it holds no value.
    target_var_name = (
        shared_entity_var_name
        if shared_entity_var_name is not None
        else build_shared_var_name(var_name, shared_with.type)
    )
    if shared_with.get_env_var(target_var_name) is None:
        shared_with.set_env_var(
            EnvVar(
                name=target_var_name,
                description=(
                    f"Shared OAuth integration for {var_name} from "
                    f"{sharing_entity.type} {sharing_entity.typeid}"
                ),
                var_type=EnvVarType.OAUTH_TOKEN,
                ref_type=BuiltinEntityType(sharing_entity.type),
                ref_name=var_name,
            )
        )
        await shared_with.update()

    logger.info(
        "[oauth] attached %s to %s's provider '%s'", shared_with.typeid, sharing_entity.typeid, var_name
    )
    return OAuthAttachmentResult(
        success=True,
        message=f"Attached {shared_with.typeid} to {sharing_entity.type} provider {var_name}",
    )


async def revoke_var_from(
    revoking_entity: Entity, var_name: str, revoked_entity_typeid: TypeId
) -> OAuthAttachmentResult:
    """Undo :func:`share_var_with`, cleaning BOTH sides.

    Idempotent: revoking something already gone is a success, not an error —
    a detach must not 500 because the user detached twice.
    """
    remaining_attachments = 0
    if revoking_entity.env_vars is not None:
        env_var = revoking_entity.get_env_var(var_name)
        if env_var is not None:
            env_var.revoke_from(revoked_entity_typeid)
            remaining_attachments = len(env_var.allowed_to_use)
            await revoking_entity.update()

    # Drop the dangling reference on the borrower too — leaving it would show a
    # row whose owner no longer consents.
    try:
        revoked_entity = await Entity.get_by_typeid(revoked_entity_typeid)
        if revoked_entity and revoked_entity.env_vars:
            stale = [
                ev.name
                for ev in revoked_entity.env_vars.values
                if ev.ref_type == BuiltinEntityType(revoking_entity.type) and ev.ref_name == var_name
            ]
            for name in stale:
                revoked_entity.remove_env_var(name)
            if stale:
                await revoked_entity.update()
    except Exception as e:  # noqa: BLE001
        logger.warning("[oauth] could not remove the reference var on the revoked entity: %s", e)

    return OAuthAttachmentResult(
        success=True,
        message=f"Revoked {revoked_entity_typeid} from {revoking_entity.type} provider {var_name}",
        remaining_attachment_count=remaining_attachments,
    )


async def disconnect_oauth_provider(user: Entity, provider: str) -> OAuthAttachmentResult:
    """Delete the user's credential outright. Distinct from detach: detaching
    from your last project keeps the token."""
    cred_name = await resolve_user_credentials_name(provider)
    if not cred_name:
        return _unknown_provider(provider)

    entity_var = user.get_env_var(provider) or user.get_env_var(cred_name)
    if entity_var is None:
        return OAuthAttachmentResult(
            success=False, message=f"SOD for provider '{provider}' not found", error=OAuthErrorCode.SOD_NOT_FOUND
        )

    from flow_sdk.app.actions.desktop_oauth import _drop_credential_row  # noqa: PLC0415
    from flow_sdk.app.actions.env_var import delete_env_var_value  # noqa: PLC0415

    try:
        await delete_env_var_value(entity_var, user)
    except Exception as e:  # noqa: BLE001
        logger.warning("[oauth] failed to delete credentials during disconnect: %s", e)
    await _drop_credential_row(user, entity_var.name)

    logger.info("[oauth] disconnected provider '%s' from %s", provider, user.typeid)
    return OAuthAttachmentResult(
        success=True,
        message=f"Disconnected OAuth provider '{provider}'",
        remaining_attachment_count=0,
    )


async def attach_action(provider: str, shared_entity_var_name: Optional[str] = None) -> OAuthAttachmentResult:
    validation = await validate_request_context()
    if not validation.is_valid:
        return validation.error

    cred_name = await resolve_user_credentials_name(provider)
    if not cred_name:
        return _unknown_provider(provider)
    return await share_var_with(
        validation.user, cred_name, validation.target_entity_typeid, shared_entity_var_name
    )


async def detach_action(provider: str) -> OAuthAttachmentResult:
    validation = await validate_request_context()
    if not validation.is_valid:
        return validation.error

    cred_name = await resolve_user_credentials_name(provider)
    if not cred_name:
        return _unknown_provider(provider)
    result = await revoke_var_from(validation.user, cred_name, validation.target_entity_typeid)

    if result.success and result.remaining_attachment_count == 0:
        # Deliberately NOT auto-disconnecting: detaching from your last project
        # must not destroy the credential. Disconnect is its own verb.
        logger.info("[oauth] no attachments remain for '%s'; keeping the credential", provider)
    return result


async def disconnect_action(provider: str) -> OAuthAttachmentResult:
    validation = await validate_request_context()
    if not validation.is_valid:
        # Disconnect is user-scoped, so a missing target entity is fine.
        if validation.error.error != OAuthErrorCode.NO_TARGET_ENTITY:
            return validation.error
        request_info = get_current_request_info()
        if not request_info or not request_info.user:
            return validation.error
        # Same re-read as the validated path — disconnect deletes the very
        # credential the cached user may not know about.
        validation.user = await get_current_request_user_fresh()

    return await disconnect_oauth_provider(validation.user, provider)
