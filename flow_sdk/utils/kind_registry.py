"""``KindRegistry`` — the one register-by-kind / look-up-by-kind table.

Six families in the tree had grown the same forty lines: a dict keyed on an
item's ``kind`` attribute, an alias table folded in by a ``normalize_*_kind``
function, a lazily-built module default, and a ``KeyError`` that names the
family. The families differ in nothing but the label, the aliases and whether
a miss raises or answers ``None`` — so that is all this class takes.

A registry is created at module import, empty; ``builder`` runs once on first
access so a family's concrete drivers (git subprocess helpers, hub clients)
load only when that family is actually used.
"""

from __future__ import annotations

from types import MappingProxyType
from typing import Any, Callable, Generic, Mapping, Optional, TypeVar

T = TypeVar("T")


class KindRegistry(Generic[T]):
    def __init__(
        self,
        label: str,
        *,
        aliases: Optional[Mapping[str, str]] = None,
        key: str = "kind",
        builder: Optional[Callable[["KindRegistry[T]"], None]] = None,
    ) -> None:
        self.label = label
        self._aliases = dict(aliases or {})
        self._key = key
        self._builder = builder
        self._built = builder is None
        self._items: dict[str, T] = {}

    # ── the alias rule, shared with the family's union discriminator ──────
    def normalize(self, kind: Any) -> str:
        """Lower/strip a kind (an enum member by its value) and fold the family's
        aliases onto canonical names."""
        name = str(getattr(kind, "value", kind) or "").strip().lower()
        return self._aliases.get(name, name)

    def _ensure(self) -> None:
        if not self._built:
            self._built = True           # before the call: a builder may re-enter
            self._builder(self)          # type: ignore[misc]

    # ── registration ─────────────────────────────────────────────────────
    def register(self, item: T, kind: Optional[str] = None) -> T:
        """Register ``item`` under its ``kind`` attribute (or an explicit key).
        Returns the item so it doubles as a decorator."""
        name = self.normalize(kind if kind is not None else getattr(item, self._key))
        self._items[name] = item
        return item

    def unregister(self, kind: str) -> bool:
        self._ensure()
        return self._items.pop(self.normalize(kind), None) is not None

    # ── lookup ───────────────────────────────────────────────────────────
    def get(self, kind: Any) -> T:
        self._ensure()
        try:
            return self._items[self.normalize(kind)]
        except KeyError as exc:
            raise KeyError(f"Unknown {self.label} kind: {kind!r}") from exc

    def get_or_none(self, kind: Any) -> Optional[T]:
        self._ensure()
        return self._items.get(self.normalize(kind))

    @property
    def aliases(self) -> Mapping[str, str]:
        return MappingProxyType(self._aliases)

    def items(self) -> list[tuple[str, T]]:
        self._ensure()
        return sorted(self._items.items())

    def kinds(self) -> list[str]:
        return [k for k, _ in self.items()]

    def __contains__(self, kind: Any) -> bool:
        self._ensure()
        return self.normalize(kind) in self._items


def kind_discriminator(default: str) -> Callable[[Any], str]:
    """The callable a pydantic ``Discriminator`` wants: the ``kind`` of a raw
    value (dict or model), defaulting to ``default`` when absent — the
    cross-version tolerant read for a pointer persisted before it had a kind."""

    def resolve(value: Any) -> str:
        if isinstance(value, dict):
            return str(value.get("kind") or default)
        return str(getattr(value, "kind", default) or default)

    return resolve
