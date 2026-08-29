"""``KindRegistry`` — the one register-by-kind table the six families share."""
from __future__ import annotations

from types import SimpleNamespace

import pytest

from flow_sdk.utils.kind_registry import KindRegistry, kind_discriminator

pytestmark = pytest.mark.timeout(5)


def _item(kind: str) -> SimpleNamespace:
    return SimpleNamespace(kind=kind)


def test_register_get_kinds_and_alias_fold():
    reg: KindRegistry[SimpleNamespace] = KindRegistry("Thing", aliases={"gh": "git"})
    git = reg.register(_item("git"))
    assert reg.get("git") is git
    assert reg.get("GH ") is git, "aliases fold after lower/strip"
    assert reg.kinds() == ["git"]
    assert "gh" in reg


def test_miss_raises_naming_the_family_or_answers_none():
    reg: KindRegistry[SimpleNamespace] = KindRegistry("Thing")
    with pytest.raises(KeyError, match="Unknown Thing kind: 'nope'"):
        reg.get("nope")
    assert reg.get_or_none("nope") is None


def test_explicit_key_attribute_and_explicit_kind():
    reg: KindRegistry[SimpleNamespace] = KindRegistry("Driver", key="provider")
    rss = reg.register(SimpleNamespace(provider="rss"))
    assert reg.get("rss") is rss
    by_name = reg.register(SimpleNamespace(), kind="copy")
    assert reg.get("copy") is by_name


def test_unregister_and_kinds_are_sorted():
    reg: KindRegistry[SimpleNamespace] = KindRegistry("Thing")
    reg.register(_item("b")); reg.register(_item("a"))
    assert reg.kinds() == ["a", "b"]
    assert reg.unregister("b") is True
    assert reg.unregister("b") is False
    assert reg.kinds() == ["a"]


def test_builder_runs_once_on_first_access():
    calls: list[int] = []

    def build(r: KindRegistry[SimpleNamespace]) -> None:
        calls.append(1)
        r.register(_item("x"))

    reg: KindRegistry[SimpleNamespace] = KindRegistry("Thing", builder=build)
    assert calls == [], "lazy: nothing runs at construction"
    assert reg.get("x").kind == "x"
    reg.kinds(); reg.get_or_none("y")
    assert calls == [1]


def test_kind_discriminator_defaults_when_absent():
    resolve = kind_discriminator("git")
    assert resolve({"kind": "local"}) == "local"
    assert resolve({}) == "git"
    assert resolve(SimpleNamespace(kind="")) == "git"
    assert resolve(SimpleNamespace()) == "git"
