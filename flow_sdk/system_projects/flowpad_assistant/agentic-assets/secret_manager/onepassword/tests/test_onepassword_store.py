"""``onepassword`` — a 1Password vault through the ``op`` CLI, against a fake ``op``.

Pinned: one item per name under ``item_prefix``; a value never rides a command line (writes go as a
JSON template on stdin); a missing item is absent, not an error; signed-out and denied map to the
store errors every caller already handles.
"""
from __future__ import annotations

import json

import pytest

from flow_sdk.secrets import SecretStore, StoreAccessDenied, StoreNeedsConnection
from flow_sdk.secrets.managers import store_class

OnePasswordStore = store_class("onepassword")

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(10)]  # do not increase timeout without approval


class FakeOp:
    """An in-memory ``op``: ``items`` is ``{title: value}``; every call is recorded."""

    def __init__(self, items=None, fail: str = ""):
        self.items = dict(items or {})
        self.fail = fail
        self.calls: list[tuple[list[str], str | None]] = []

    async def __call__(self, args, stdin=None):
        self.calls.append((list(args), stdin))
        if self.fail:
            return 1, "", self.fail
        verb = args[:2]
        if verb == ["item", "get"]:
            title = args[2]
            if title not in self.items:
                return 1, "", f'"{title}" isn\'t an item in the vault'
            return 0, json.dumps({"value": self.items[title]}), ""
        if verb == ["item", "list"]:
            return 0, json.dumps([{"title": t} for t in self.items]), ""
        if verb == ["item", "create"]:
            template = json.loads(stdin)
            self.items[template["title"]] = template["fields"][0]["value"]
            return 0, "{}", ""
        if verb == ["item", "delete"]:
            return (0, "", "") if self.items.pop(args[2], None) is not None else (1, "", "isn't an item")
        return 1, "", "unknown"


@pytest.fixture
def op(monkeypatch):
    fake = FakeOp({"GTM_OTHER": "x"})
    monkeypatch.setattr(OnePasswordStore, "run", staticmethod(fake))
    return fake


def _store():
    return SecretStore.from_ref({"type": "onepassword", "config": {"vault": "GTM Studio", "item_prefix": "GTM_"}})


async def test_save_then_load_round_trips_under_the_prefix(op):
    store = _store()
    await store.save({"BRIGHT_DATA_API": "bd-secret"})

    assert op.items["GTM_BRIGHT_DATA_API"] == "bd-secret"
    loaded = await store.load(["BRIGHT_DATA_API", "ABSENT"])
    assert {k: v.get_secret_value() for k, v in loaded.items()} == {"BRIGHT_DATA_API": "bd-secret"}
    assert sorted(await store.names()) == ["BRIGHT_DATA_API", "OTHER"]


async def test_a_value_never_rides_the_command_line(op):
    await _store().save({"BRIGHT_DATA_API": "bd-secret"})
    await _store().save({"BRIGHT_DATA_API": "rotated"})  # an update deletes and re-creates

    assert all("bd-secret" not in a and "rotated" not in a for args, _ in op.calls for a in args)
    assert op.items["GTM_BRIGHT_DATA_API"] == "rotated"


async def test_forget_deletes_only_what_is_held(op):
    await _store().save({"A": "1"})
    assert await _store().forget(["A", "NOT_THERE"]) == (["A"], [])


async def test_signed_out_and_denied_are_the_store_errors(monkeypatch):
    monkeypatch.setattr(OnePasswordStore, "run", staticmethod(FakeOp(fail="[ERROR] You are not currently signed in.")))
    with pytest.raises(StoreNeedsConnection):
        await _store().load(["A"])

    monkeypatch.setattr(OnePasswordStore, "run", staticmethod(FakeOp(fail="[ERROR] You do not have permission")))
    with pytest.raises(StoreAccessDenied):
        await _store().load(["A"])


async def test_the_vault_store_comes_from_the_manager_and_says_where():
    from flow_sdk.secrets.managers import store_for

    store = store_for({"manager": "onepassword", "config": {"vault": "GTM Studio"}})
    assert isinstance(store, OnePasswordStore) and store.where == "1Password vault GTM Studio"


async def test_every_call_names_the_account_when_set(monkeypatch):
    seen: list[list[str]] = []
    inner = FakeOp()

    async def fake(args, stdin=None):
        seen.append(list(args))
        assert args[:2] == ["--account", "team.1password.com"]
        return await inner(args[2:], stdin)

    monkeypatch.setattr(OnePasswordStore, "run", staticmethod(fake))
    store = SecretStore.from_ref({"type": "onepassword", "config": {"vault": "V", "account": "team.1password.com"}})
    await store.save({"A": "1"})
    await store.load(["A"])
    await store.forget(["A"])
    assert {a[2] + " " + a[3] for a in seen} == {"item list", "item create", "item get", "item delete"}
