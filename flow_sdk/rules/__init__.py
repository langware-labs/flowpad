"""Rules engine stubs.

The original ``ActivationRule`` Record-subclass + RuleEngine were removed
in the Record-subclass deletion pass. These minimal stubs keep imports
working; real rules functionality is deferred to a follow-up rewrite.
"""
from __future__ import annotations

from typing import Any


class ActivationRule:
    """No-op stub. Original Record subclass removed."""

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


class ActivationRuleCase:
    """No-op stub."""

    def __init__(self, **kwargs: Any) -> None:
        for k, v in kwargs.items():
            setattr(self, k, v)


__all__ = ["ActivationRule", "ActivationRuleCase"]
