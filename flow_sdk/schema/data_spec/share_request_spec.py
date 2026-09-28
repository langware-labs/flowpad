"""``ShareRequestSpec`` — the typed body of ``POST /graph/<type>/<id>/share``.

``recipients`` arrive as a bare ``idOrEmail`` string or ``{idOrEmail, role?}``
and resolve to a ``ShareInvitee``; ``teams`` are ``team-<uuid>`` typeids.
The handler lives in ``flow_sdk/app/actions/share_action.py``.
"""
from __future__ import annotations

from typing import Annotated, Optional, Union

from pydantic import (
    AfterValidator,
    BaseModel,
    ConfigDict,
    Field,
    StringConstraints,
    TypeAdapter,
    model_validator,
)

from flow_sdk.schema.data_spec.spec import DataSpec

NonEmptyStr = Annotated[str, StringConstraints(min_length=1)]


class ShareInvitee(BaseModel):
    """One resolved recipient of a ``share`` invite: the internal
    email/user_id split ``Project.share`` / ``Conversation.share`` take.
    Build it from wire input via ``WireInvitee`` / ``ShareInvitee.from_wire``.
    """

    model_config = ConfigDict(extra="forbid")

    email: Optional[str] = None
    user_id: Optional[str] = None
    role: Optional[str] = None

    @model_validator(mode="after")
    def _exactly_one_identifier(self) -> "ShareInvitee":
        if bool(self.email) == bool(self.user_id):
            raise ValueError("each invitee needs exactly one of 'email' or 'user_id'")
        return self

    @classmethod
    def from_wire(cls, item: object) -> "ShareInvitee":
        return _wire_adapter.validate_python(item)


class _InviteeWireObject(BaseModel):
    """The ``{idOrEmail, role?}`` wire shape, used when a role is needed."""

    model_config = ConfigDict(extra="forbid")

    id_or_email: NonEmptyStr = Field(alias="idOrEmail")
    role: Optional[str] = None


def _resolve(item: Union[str, _InviteeWireObject]) -> ShareInvitee:
    """Resolve ``idOrEmail`` as a hub id FIRST, falling back to email.
    ``recipient_user_id`` only matches a real UUID; ``normalize_email`` has
    no ``@`` check, so testing email first would misfile every bare UUID.
    """
    from flow_sdk.builtin.user import normalize_email, recipient_user_id  # noqa: PLC0415

    if isinstance(item, str):
        id_or_email, role = item, None
    else:
        id_or_email, role = item.id_or_email, item.role

    if user_id := recipient_user_id(id_or_email):
        return ShareInvitee(user_id=user_id, role=role)
    return ShareInvitee(email=normalize_email(id_or_email), role=role)


# A ``recipients`` entry on the wire: either a bare "email-or-id" string (the
# original flat shape, kept so existing callers don't break) or
# ``{idOrEmail, role?}``. Validates straight to a resolved ``ShareInvitee``.
WireInvitee = Annotated[
    Union[NonEmptyStr, _InviteeWireObject],
    Field(union_mode="left_to_right"),
    AfterValidator(_resolve),
]

_wire_adapter = TypeAdapter(WireInvitee)


def _team_typeid(value: str) -> str:
    """A picked team travels as its ``team-<uuid>`` typeid."""
    from flow_sdk.api.api_types.identifier import is_valid_uuid  # noqa: PLC0415

    value = value.strip()
    if not (value.startswith("team-") and is_valid_uuid(value.removeprefix("team-"))):
        raise ValueError(f"not a team typeid: {value!r}")
    return value


TeamTypeId = Annotated[str, AfterValidator(_team_typeid)]


class ShareRequestSpec(DataSpec):
    """The body of ``POST /graph/<type>/<id>/share``.

    * ``recipients`` — people to invite, each a bare ``idOrEmail`` string or
      ``{idOrEmail, role?}``, resolved to a ``ShareInvitee``.
    * ``teams`` — ``team-<uuid>`` typeids, each granted on the hub as ONE group
      principal by ``Project.share`` (no expansion into people).
    * ``note`` — the sharer's personal message, carried in each invite message.

    ``teams`` and ``note`` apply to a Project share only; the handler enforces
    that, since it depends on the target in the URL, not on the body.
    """

    model_config = ConfigDict(frozen=True)

    recipients: tuple[WireInvitee, ...] = ()
    teams: tuple[TeamTypeId, ...] = ()
    note: Optional[str] = None

    @classmethod
    def from_body(cls, body: dict) -> "ShareRequestSpec":
        """Project the share keys out of a raw request body, field by field.

        The TS SDK posts the entity's own JSON alongside ``recipients``, so the
        body is a foreign dict: anything but the three share keys is dropped
        here rather than rejected by the spec's ``extra="forbid"``.
        """
        return cls.model_validate({key: body[key] for key in _SHARE_KEYS if body.get(key) is not None})


_SHARE_KEYS = ("recipients", "teams", "note")
