"""PropertyRecord — Pydantic-Field-style descriptor for TTL-cached computed properties.

Assign at class level on a Record subclass. Access transparently on instances.

    class MyRecord(Record):
        is_active = PropertyRecord(ttl=-1, discovery=lambda r: check_active(r))
        errors    = PropertyRecord(ttl=60, list_key="errors", discovery=lambda r: get_errs(r))

    record.is_active   # → bool, TTL-cached
    record.errors      # → list, TTL-cached, stored under key "errors" in state.json
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any, Callable, ClassVar, TYPE_CHECKING

if TYPE_CHECKING:
    from .record import Record


class PropertyRecord:
    """Descriptor for TTL-cached computed properties on Record subclasses.

    Instances live as class attributes (like Pydantic Field).
    Cached values are stored as plain dicts in the parent record's RecordState.

    Subclass and override ``run_discovery()`` for complex logic, or pass
    ``discovery=callable`` for inline logic.
    """

    _record_type: ClassVar[str] = "property"   # identifies subtype in state.json
    _default_ttl: ClassVar[float] = 300

    def __init__(
        self,
        *,
        ttl: float | None = None,
        default: Any = None,
        list_key: str | None = None,
        discovery: "Callable[[Record], Any] | None" = None,
    ) -> None:
        cls = type(self)
        self._ttl: float = ttl if ttl is not None else cls._default_ttl
        self._default: Any = default
        self._list_key: str | None = list_key
        self._discovery_fn: "Callable | None" = discovery
        self._name: str = ""  # filled by __set_name__

    # ── Descriptor protocol ───────────────────────────────────────────────

    def __set_name__(self, owner: type, name: str) -> None:
        """Called by Python when the descriptor is assigned at class definition time."""
        self._name = name
        # Own _property_types dict per class (don't mutate inherited one)
        if "_property_types" not in owner.__dict__:
            # Seed from the nearest base class that has one
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
        return instance.get_prop(self._name)

    # ── TTL / expiry ──────────────────────────────────────────────────────

    def is_expired(self, entry: dict) -> bool:
        """True if the cached entry has exceeded its TTL. Always False when ttl=-1."""
        if self._ttl == -1:
            return False
        # Support both new "computed_at" key and old "discovered_at" key for migration
        da = entry.get("computed_at") or entry.get("discovered_at")
        if not da:
            return True
        try:
            dt = datetime.fromisoformat(da)
            return (datetime.now(timezone.utc) - dt).total_seconds() > self._ttl
        except (ValueError, TypeError):
            return True

    # ── Discovery ─────────────────────────────────────────────────────────

    def run_discovery(self, instance: "Record", force: bool = False) -> Any:
        """Compute the property value for *instance*.

        Override in subclasses for complex logic.
        Or pass ``discovery=callable`` to the constructor for inline logic.
        """
        if self._discovery_fn is not None:
            return self._discovery_fn(instance)
        return self._default

    # ── Serialization ─────────────────────────────────────────────────────

    def to_index_entry(self, value: Any) -> dict:
        """Build the dict stored in index.json under ``fields[key]``."""
        entry: dict = {
            "type": type(self)._record_type,
            "ttl": self._ttl,
            "computed_at": datetime.now(timezone.utc).isoformat(),
        }
        if self._list_key is not None:
            # Named list key instead of generic "value" for readability
            entry[self._list_key] = value if isinstance(value, list) else []
        else:
            entry["value"] = value
        return entry

    def get_value(self, entry: dict) -> Any:
        """Extract the property value from a stored index entry."""
        if self._list_key is not None:
            return entry.get(
                self._list_key,
                self._default if self._default is not None else [],
            )
        return entry.get("value", self._default)
