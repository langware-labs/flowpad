from enum import Flag, auto
from typing import Any, Callable, Dict, List, Union

from pydantic import Field
from pydantic.fields import PydanticUndefined

from flow_sdk._compat import StrEnum

JSONType = Union[str, int, float, bool, None, Dict[str, "JSONType"], List[Any]]


class FieldFlags(Flag):
    STORE = auto()  # 1 (binary: 0001)
    CACHED = auto()  # 2 (binary: 0010)
    DB_EXCLUDE = auto()  # 4 (binary: 0100)


class Sharing(StrEnum):
    """Which way a field's value may cross the boundary to another machine.

    One declaration replacing six hand-maintained name lists (``_BASE_LOCAL_FIELDS``,
    ``TypeInfo.local_fields``, ``_hub_body``'s exclude literal, ``LOCAL_ONLY_FIELDS``
    and its subclass unions, ``HUB_AUTHORITATIVE_FIELDS``, ``_STALE_IGNORE_FIELDS``).
    Those lists disagreed with each other; a field can only carry one answer.

    Read it as a DIRECTION, not a place:

    - ``SHARED``    — send it, and accept a peer's value. The default, so no
                      existing declaration changes meaning.
    - ``HUB_WRITE`` — send it, never accept. Per-device state ABOUT a shared thing:
                      has this machine downloaded the body, has this user read it.
                      A hub refresh must not reset those.
    - ``HUB_READ``  — accept it, never send. The hub owns the value and we never
                      stamp it (the LWW clock: a local re-stamp runs it ahead and
                      pins ``is_stale`` False, masking real changes).
    - ``PRIVATE``   — neither. Never leaves this machine, never accepted from
                      outside: local placement, local flags, local projections.

    The share-bundle axis is DERIVED, not declared: a bundle strips exactly
    ``PRIVATE`` — no field needs to say otherwise.

    Deliberately named ``PRIVATE`` rather than ``LOCAL``: "local" already means a
    privacy switch (``is_local_mode``), a compute node (``@local``), a storage
    driver, and a member of eight unrelated enums. ``private`` is unused and
    matches the vocabulary this module already established for
    ``shared_context_entities`` vs ``private_context_entities_``.
    """

    SHARED = "shared"
    HUB_WRITE = "hub_write"
    HUB_READ = "hub_read"
    PRIVATE = "private"


class Persist(StrEnum):
    """Whether a field is mirrored into the on-disk record metadata.json.

    - ``TRUE``    → always written.
    - ``FALSE``   → never written (DB-only: computed / denormalized / runtime).
    - ``DEFAULT`` → written iff the field is declared in the type's metadata
                    model (``TypeInfo.meta_model``). This is the field default,
                    so existing declarations need no change.
    """
    TRUE = "true"
    FALSE = "false"
    DEFAULT = "default"


def EntityField(
    default: Any = PydanticUndefined,
    *,
    default_factory: Callable[[], Any] | Callable[[dict[str, Any]], Any] | None = PydanticUndefined,
    blob=False,
    db_exclude=False,
    role: str = "*",
    persist: Persist = Persist.DEFAULT,
    sharing: Sharing = Sharing.SHARED,
    hub_name: str | None = None,
    json_schema_extra: dict[str, Any] | None = None,
    **kwargs,
):
    json_schema_extra = {
        **(json_schema_extra or {}),
        "role": role,
        "blob": blob,
        "db_exclude": db_exclude,
        "persist": str(Persist(persist)),
        "sharing": str(Sharing(sharing)),
        # The key the (release-pinned) hub reads this field under, when it differs.
        **({"hub_name": hub_name} if hub_name else {}),
    }
    return Field(default=default, default_factory=default_factory, json_schema_extra=json_schema_extra, **kwargs)


def persist_policy(field_info) -> Persist:
    """Read the ``persist`` policy off a pydantic FieldInfo. Defaults to DEFAULT."""
    extra = field_info.json_schema_extra
    if extra and isinstance(extra, dict):
        raw = extra.get("persist")
        if raw is not None:
            return Persist(raw)
    return Persist.DEFAULT


def _extra(field_info) -> dict:
    """The ``json_schema_extra`` dict, or empty.

    Works for a pydantic ``FieldInfo`` and a ``ComputedFieldInfo`` alike — computed
    fields live in ``model_computed_fields``, a separate dict, and two of them
    (``duplicate_count``, ``private_context_entities``) carry sharing policy.
    A callable ``json_schema_extra`` is legal pydantic and has no policy to read.
    """
    extra = getattr(field_info, "json_schema_extra", None)
    return extra if isinstance(extra, dict) else {}


def sharing_policy(field_info) -> Sharing:
    """Read the ``sharing`` policy off a field. Defaults to ``Sharing.SHARED``."""
    raw = _extra(field_info).get("sharing")
    return Sharing(raw) if raw is not None else Sharing.SHARED


def is_portable(field_info) -> bool:
    """Whether this field rides a SHARE BUNDLE — everything except ``PRIVATE``.

    The bundle axis is DERIVED, with no declaration of its own. That is worth
    stating because the design initially carried a ``portable=`` override for the
    fields where the bundle disagrees with the hub direction — and once the
    policy was resolved field by field, that set turned out to be empty: the two
    ``HUB_READ`` clocks ride bundles, and everything a bundle strips is
    ``PRIVATE``. An override with no users is a flag that rots (see ``role``).
    """
    return sharing_policy(field_info) is not Sharing.PRIVATE


def is_api_visible_field(field_info):
    extra = field_info.json_schema_extra
    if extra and isinstance(extra, dict) and extra.get("api_visible", False):
        return True
    return False


def is_blob_field(field_info):
    extra = field_info.json_schema_extra
    if extra and extra.get("blob", False):
        return True
    return False


def is_db_excluded(field_info):
    if is_blob_field(field_info):
        return True
    extra = field_info.json_schema_extra
    if extra and extra.get("db_exclude", False):
        return True
    return False


def NoDbBField(default: Any = PydanticUndefined, **kwargs):
    return EntityField(default, db_exclude=True, **kwargs)


def APIField(default: Any = PydanticUndefined, blob=False, **kwargs):
    return EntityField(default, blob=blob, json_schema_extra={"api_visible": True}, **kwargs)


def NoDBAPIField(default: Any = PydanticUndefined, blob=False, **kwargs):
    return EntityField(default, blob=blob, db_exclude=True, json_schema_extra={"api_visible": True}, **kwargs)
