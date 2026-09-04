"""Deleting a credential: what goes, and what is left alone.

The rule this file pins is a PROMISE, not an implementation detail. The docs tell
the user that Flowpad "reads it, never writes over your entries, and never removes
one" about their `.env.local`, so a Delete button that quietly edited that file
would make the product lie. The decision lives on the driver, because whether a
value may be deleted is a property of the STORE, not of whoever pressed the button.
"""

import pytest

from flow_sdk.builtin.drivers.env_local_secret_driver import EnvLocalSecretDriver
from flow_sdk.builtin.drivers.hub_secret_driver import HubSecretDriver
from flow_sdk.builtin.drivers.local_secret_driver import LocalSecretDriver
from flow_sdk.builtin.project import Project
from flow_sdk.builtin.secret_origin_refs import EnvLocalSecretRef, LocalSecretRef

pytestmark = pytest.mark.asyncio


async def test_the_encrypted_store_is_ours_to_empty(monkeypatch):
    """`sodot` is Flowpad's own store, so Delete really deletes."""
    seen: list[str] = []

    async def fake_delete(name: str) -> None:
        seen.append(name)

    # The driver binds the name at import, so patch it THERE.
    monkeypatch.setattr(
        "flow_sdk.builtin.drivers.local_secret_driver.delete_secret", fake_delete
    )

    forgotten = await LocalSecretDriver().forget(LocalSecretRef(sod_name="TWILIO_AUTH_TOKEN"))

    assert forgotten is True
    assert seen == ["TWILIO_AUTH_TOKEN"]


async def test_env_local_is_never_touched():
    """The user's own file. Append-only by policy — and note this returns False
    rather than raising: not deleting is a normal outcome the UI reports, not an
    error it recovers from."""
    forgotten = await EnvLocalSecretDriver().forget(EnvLocalSecretRef(env_key="GMAIL_ADDRESS"))

    assert forgotten is False


async def test_a_cloud_value_is_deleted_by_its_own_act():
    """`delete-secret-from-cloud` removes it "from there and nowhere else". A local
    delete must not become a delete for every machine the project is shared with."""
    assert await HubSecretDriver().forget(EnvLocalSecretRef(env_key="SHARED_KEY")) is False


async def test_a_driver_with_no_name_deletes_nothing(monkeypatch):
    """Guard the empty-coordinate case: `delete_secret("")` on the store would be
    an unbounded request, and there is nothing to delete anyway."""
    called = False

    async def fake_delete(name: str) -> None:
        nonlocal called
        called = True

    # The driver binds the name at import, so patch it THERE.
    monkeypatch.setattr(
        "flow_sdk.builtin.drivers.local_secret_driver.delete_secret", fake_delete
    )

    assert await LocalSecretDriver().forget(LocalSecretRef(sod_name="")) is False
    assert not called


async def test_the_digest_goes_even_when_the_value_stays(monkeypatch):
    """The digest is our record ABOUT the value, not the value.

    A `.env.local` value survives a delete, but the salted digest that remembers
    what it was is keyed to a declaration that no longer exists — leaving it puts
    an orphan in the encrypted store with nothing left to describe.
    """
    cleared: list[str] = []

    async def fake_clear(project_id: str, env_var: str) -> None:
        cleared.append(env_var)

    monkeypatch.setattr("flow_sdk.builtin.secret_origin_digest.clear_digest", fake_clear)

    project = _ProjectStub(
        [{"typeid": "so-1", "env_var": "GMAIL_ADDRESS", "locator": {"kind": "env-local", "env_key": "GMAIL_ADDRESS"}}]
    )
    result = await Project.delete_secrets(project, typeids=["so-1"])

    assert result.data["kept"] == ["GMAIL_ADDRESS"]
    assert result.data["deleted"] == []
    assert cleared == ["GMAIL_ADDRESS"]


class _ProjectStub:
    """Just enough Project for the action: it reads `secret_origins` and calls
    `_detach_secret_pointers`, and neither needs a database here."""

    def __init__(self, origins):
        self.secret_origins = origins
        self.id = "11111111-1111-4111-8111-111111111111"
        self.removed: list[str] = []

    async def _detach_secret_pointers(self, targets):
        # One detach for the whole list — the action collects targets and saves once.
        self.removed.extend(str(t) for t in targets)
