"""
Tracked collections that automatically mark parent entities as dirty on mutations.

This module provides TrackedList and TrackedDict classes that wrap standard Python
collections and automatically set the parent entity's _dirty flag to True when
any mutation occurs.

Usage:
    These classes are automatically applied to all list and dict fields in DBEntity
    subclasses via the _wrap_mutable_fields model_validator. No manual wrapping needed.

Example:
    class MyEntity(DBEntity):
        tags: List[str] = []  # Automatically becomes TrackedList
        metadata: Dict[str, str] = {}  # Automatically becomes TrackedDict

    entity = MyEntity()
    entity.tags.append("new")  # Automatically sets entity._dirty = True
"""

from typing import Generic, TypeVar

T = TypeVar("T")
K = TypeVar("K")
V = TypeVar("V")


class TrackedList(list, Generic[T]):
    """
    List subclass that automatically marks parent entity as dirty on mutations.

    This class wraps a standard Python list and intercepts all mutation methods
    (append, extend, remove, etc.) to set the parent entity's _dirty flag.

    Attributes:
        _parent: Reference to the parent entity (DBEntity instance)
    """

    __slots__ = ("_parent",)

    def __init__(self, iterable=None, parent=None):
        """
        Initialize TrackedList.

        Args:
            iterable: Optional initial items
            parent: Reference to parent entity (DBEntity instance)
        """
        self._parent = parent
        if iterable:
            super().__init__(iterable)
        else:
            super().__init__()

    def _mark_dirty(self):
        """Mark parent entity as dirty if parent exists and has _dirty attribute."""
        if self._parent is not None and hasattr(self._parent, "_dirty"):
            self._parent._dirty = True

    # Mutation methods that modify the list in-place
    def append(self, item: T):
        """Append item and mark parent dirty."""
        super().append(item)
        self._mark_dirty()

    def extend(self, items):
        """Extend list and mark parent dirty."""
        super().extend(items)
        self._mark_dirty()

    def insert(self, index: int, item: T):
        """Insert item and mark parent dirty."""
        super().insert(index, item)
        self._mark_dirty()

    def remove(self, item: T):
        """Remove item and mark parent dirty."""
        super().remove(item)
        self._mark_dirty()

    def pop(self, index: int = -1):
        """Pop item and mark parent dirty."""
        result = super().pop(index)
        self._mark_dirty()
        return result

    def clear(self):
        """Clear list and mark parent dirty."""
        super().clear()
        self._mark_dirty()

    def __setitem__(self, key, value):
        """Set item and mark parent dirty."""
        super().__setitem__(key, value)
        self._mark_dirty()

    def __delitem__(self, key):
        """Delete item and mark parent dirty."""
        super().__delitem__(key)
        self._mark_dirty()

    def __iadd__(self, other):
        """In-place add and mark parent dirty."""
        result = super().__iadd__(other)
        self._mark_dirty()
        return result

    def __imul__(self, other):
        """In-place multiply and mark parent dirty."""
        result = super().__imul__(other)
        self._mark_dirty()
        return result

    def reverse(self):
        """Reverse list and mark parent dirty."""
        super().reverse()
        self._mark_dirty()

    def sort(self, **kwargs):
        """Sort list and mark parent dirty."""
        super().sort(**kwargs)
        self._mark_dirty()


class TrackedDict(dict, Generic[K, V]):
    """
    Dict subclass that automatically marks parent entity as dirty on mutations.

    This class wraps a standard Python dict and intercepts all mutation methods
    (setitem, update, pop, etc.) to set the parent entity's _dirty flag.

    Attributes:
        _parent: Reference to the parent entity (DBEntity instance)
    """

    __slots__ = ("_parent",)

    def __init__(self, *args, parent=None, **kwargs):
        """
        Initialize TrackedDict.

        Args:
            *args: Positional arguments for dict constructor
            parent: Reference to parent entity (DBEntity instance)
            **kwargs: Keyword arguments for dict constructor
        """
        self._parent = parent
        super().__init__(*args, **kwargs)

    def _mark_dirty(self):
        """Mark parent entity as dirty if parent exists and has _dirty attribute."""
        if self._parent is not None and hasattr(self._parent, "_dirty"):
            self._parent._dirty = True

    # Mutation methods that modify the dict in-place
    def __setitem__(self, key: K, value: V):
        """Set item and mark parent dirty."""
        super().__setitem__(key, value)
        self._mark_dirty()

    def __delitem__(self, key: K):
        """Delete item and mark parent dirty."""
        super().__delitem__(key)
        self._mark_dirty()

    def update(self, *args, **kwargs):
        """Update dict and mark parent dirty."""
        super().update(*args, **kwargs)
        self._mark_dirty()

    def pop(self, key: K, *args):
        """Pop item and mark parent dirty."""
        result = super().pop(key, *args)
        self._mark_dirty()
        return result

    def popitem(self):
        """Pop item and mark parent dirty."""
        result = super().popitem()
        self._mark_dirty()
        return result

    def clear(self):
        """Clear dict and mark parent dirty."""
        super().clear()
        self._mark_dirty()

    def setdefault(self, key: K, default: V = None):
        """Set default and mark parent dirty."""
        result = super().setdefault(key, default)
        self._mark_dirty()
        return result
