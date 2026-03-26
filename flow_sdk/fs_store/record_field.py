"""RecordField — unified descriptor for stored and computed fields on Record subclasses.

Two modes, determined at instantiation:

  Stored (ttl=None, discovery=None):
    class Article(Record):
        title: str = RecordField(default="", index=True)
        tags: list = RecordField(default_factory=list)

    - Reads/writes through the Record's instance __dict__ (metadata.json).
    - Typed, defaulted, optionally indexed in FTS.
    - Defaults applied by Record.__init__ and from_dict.

  Computed (ttl or discovery provided):
    class Session(Record):
        is_active: bool = RecordField(ttl=30, discovery=lambda r: check(r))

    - Identical to the former PropertyRecord: TTL-cached in state.json.
    - Registered in _property_types; accessed via instance.get_prop().

PropertyRecord is now an alias for RecordField.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, ClassVar, TYPE_CHECKING

if TYPE_CHECKING:
    from .record import Record


class _MissingType:
    """Sentinel — distinguishes 'no default provided' from default=None."""

    def __repr__(self) -> str:
        return "MISSING"


MISSING = _MissingType()


class RecordField:
    """Descriptor for stored data fields and computed/TTL-cached properties on Records.

    Stored mode  (ttl=None, discovery=None):
        Participates in Record.__init__ default application and index_fields merging.
        Values live in the instance __dict__ (serialised to metadata.json).

    Computed mode  (ttl or discovery supplied):
        Behaves exactly like the former PropertyRecord.
        Values are TTL-cached in state.json via Record.get_prop().

    Subclass and override run_discovery() for custom computed logic, or pass
    discovery=callable for inline logic.
    """

    _record_type: ClassVar[str] = "property"  # state.json compat
    _default_ttl: ClassVar[float] = 300

    def __init__(
        self,
        *,
        ttl: float | None = None,
        default: Any = MISSING,
        default_factory: Callable[[], Any] | None = None,
        list_key: str | None = None,
        discovery: "Callable[[Record], Any] | None" = None,
        index: bool = False,
    ) -> None:
        if default is not MISSING and default_factory is not None:
            raise TypeError("RecordField: specify 'default' or 'default_factory', not both")
        if default_factory is not None and (ttl is not None or discovery is not None):
            raise TypeError("RecordField: 'default_factory' is only valid for stored fields (no ttl/discovery)")

        self._ttl_param = ttl          # raw param — None means "not provided"
        self._default: Any = default
        self._default_factory: Callable[[], Any] | None = default_factory
        self._list_key: str | None = list_key
        self._discovery_fn: "Callable | None" = discovery
        self._index: bool = index
        self._name: str = ""           # filled by __set_name__

        # For computed mode, resolve _ttl now (uses class-level _default_ttl)
        if not self._is_stored:
            cls = type(self)
            self._ttl: float = ttl if ttl is not None else cls._default_ttl
        else:
            self._ttl = 0.0  # unused in stored mode

    # ── Mode ─────────────────────────────────────────────────────────────────

    @property
    def _is_stored(self) -> bool:
        """True when this descriptor manages a plain stored field (not computed/TTL-cached).

        Only direct RecordField instances (not subclasses) without ttl/discovery are stored.
        Subclasses always behave as computed fields — this preserves backward compatibility
        with PropertyRecord subclasses that omit ttl/discovery from their __init__.
        """
        return (
            type(self) is RecordField
            and self._ttl_param is None
            and self._discovery_fn is None
        )

    # ── Descriptor protocol ───────────────────────────────────────────────────

    def __set_name__(self, owner: type, name: str) -> None:
        """Called by Python when the descriptor is assigned at class definition time."""
        self._name = name

        if self._is_stored:
            # Register in _field_defs — one dict per class, seeded from nearest parent.
            if "_field_defs" not in owner.__dict__:
                base_defs: dict = {}
                for base in owner.__mro__[1:]:
                    if "_field_defs" in base.__dict__:
                        base_defs = dict(base.__dict__["_field_defs"])
                        break
                owner._field_defs = base_defs
            owner._field_defs[name] = self
        else:
            # Computed mode: register in _property_types (same as former PropertyRecord).
            if "_property_types" not in owner.__dict__:
                base_props: dict = {}
                for base in owner.__mro__[1:]:
                    if "_property_types" in base.__dict__:
                        base_props = dict(base.__dict__["_property_types"])
                        break
                owner._property_types = base_props
            owner._property_types[name] = self

    def __get__(self, instance: "Record | None", owner: type | None = None) -> Any:
        if instance is None:
            return self  # class-level access → return the descriptor itself

        if self._is_stored:
            # Value lives in instance __dict__ (put there by __init__ or from_dict).
            # We are a non-data descriptor, so Python already checked __dict__ first;
            # __get__ is only called when the key is absent (e.g. old records on disk
            # that predate this field).  Return the declared default as a safe fallback.
            if self._default_factory is not None:
                return self._default_factory()
            if self._default is not MISSING:
                return self._default
            return None

        # Computed mode: delegate to TTL-aware get_prop().
        return instance.get_prop(self._name)

    # ── TTL / expiry (computed mode) ──────────────────────────────────────────

    def is_expired(self, entry: dict) -> bool:
        """True if the cached entry has exceeded its TTL. Always False when ttl=-1."""
        if self._ttl == -1:
            return False
        da = entry.get("computed_at") or entry.get("discovered_at")
        if not da:
            return True
        try:
            dt = datetime.fromisoformat(da)
            return (datetime.now(timezone.utc) - dt).total_seconds() > self._ttl
        except (ValueError, TypeError):
            return True

    # ── Discovery (computed mode) ─────────────────────────────────────────────

    def run_discovery(self, instance: "Record", force: bool = False) -> Any:
        """Compute the property value for *instance*.

        Override in subclasses for complex logic, or pass discovery=callable to
        the constructor for inline logic.
        """
        if self._discovery_fn is not None:
            return self._discovery_fn(instance)
        default = self._default
        return default if default is not MISSING else None

    # ── Serialization (computed mode) ─────────────────────────────────────────

    def to_index_entry(self, value: Any) -> dict:
        """Build the dict stored in state.json under fields[key]."""
        entry: dict = {
            "type": type(self)._record_type,
            "ttl": self._ttl,
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }
        if self._list_key is not None:
            entry[self._list_key] = value if isinstance(value, list) else []
        else:
            entry["value"] = value
        return entry

    def get_value(self, entry: dict) -> Any:
        """Extract the property value from a stored state.json entry."""
        default = self._default if self._default is not MISSING else None
        if self._list_key is not None:
            return entry.get(self._list_key, default if default is not None else [])
        return entry.get("value", default)
