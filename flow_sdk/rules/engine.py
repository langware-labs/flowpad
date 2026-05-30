"""Rules engine stub. Original implementation removed with ActivationRule subclass."""
from __future__ import annotations

from typing import Any


class RuleEngine:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        pass

    def evaluate(self, *args: Any, **kwargs: Any) -> list:
        return []

    def rules(self) -> list:
        return []


class RulesPackage:
    def __init__(self, *args: Any, **kwargs: Any) -> None:
        self.rules: list = []
