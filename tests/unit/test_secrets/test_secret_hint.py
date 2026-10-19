"""A stored secret's shadow record carries a masked hint of the value, never the value.

``get_secrets`` lists shadow records without opening the sod, so the hint is the only way a
listing can say WHICH key is stored (``****last4``). A record written before hints existed lists
an empty hint rather than failing.
"""
from __future__ import annotations

from flow_sdk.cli.auth.secrets import _get_app_secret, get_secrets, write_secret


def _listed(name: str) -> dict:
    return next(s for s in get_secrets() if s["name"] == name)


async def test_write_secret_shadows_a_masked_hint_and_not_the_value(home):
    write_secret("lm_api.hint-test", "sk-or-v1-abcdef1234", description="a key")

    record = _get_app_secret("lm_api.hint-test")
    assert record.__dict__["hint"] == "****1234"
    assert "sk-or-v1-abcdef1234" not in repr(record.__dict__)
    assert _listed("lm_api.hint-test")["hint"] == "****1234"


async def test_rewriting_a_secret_refreshes_its_hint(home):
    write_secret("lm_api.hint-test", "first-value-1111")
    write_secret("lm_api.hint-test", "second-value-2222", description="rotated")

    listed = _listed("lm_api.hint-test")
    assert listed["hint"] == "****2222" and listed["description"] == "rotated"


async def test_a_record_stored_before_hints_lists_an_empty_hint(home):
    from flow_sdk.fs_store.fs_record import FSRecord
    from flow_sdk.fs_store.record_types import RecordType

    FSRecord(type=RecordType.APP_SECRET, id="lm_api.legacy", name="lm_api.legacy").save()
    assert _listed("lm_api.legacy")["hint"] == ""
