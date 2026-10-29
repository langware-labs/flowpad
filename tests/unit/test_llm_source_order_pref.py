"""``preferences.llm.source_order``: which KIND of source wins when nobody asked (rung 4).

The default is device < api_key < endpoint. The preference reorders those rank bands only; a
process or project pin still wins. Fixtures and helpers are the ones in
tests/unit/test_llm_source_resolution.py.
"""

from __future__ import annotations

import pytest

from flow_sdk.preferences import PREF_LLM_SOURCE_ORDER, write_instance_pref
from tests.unit.test_llm_source_resolution import (  # noqa: F401 — fixtures
    EP1,
    EP2,
    _bind,
    _by_kind,
    _clean,
    _list_sources,
    _resolve_source,
    _signed_in,
    _status_facts,
    env,
    harness_installed,
)
from tests.unit.test_llm_source_resolution import _process as _proc

pytestmark = pytest.mark.usefixtures("harness_installed", "env")


async def _ranks(monkeypatch) -> dict[str, int]:
    """The rank of each kind's eligible source, with all three available (device, key, endpoint)."""
    from flow_sdk.builtin.agentic_process.cli_drivers.llm_source import list_llm_candidates
    from flow_sdk.lm_api import LMApiProvider, set_lm_api

    _bind(monkeypatch)
    set_lm_api("sk-or-test", LMApiProvider.OPENROUTER)
    await _signed_in("claude")
    listed = await list_llm_candidates("claude")
    out = {}
    for kind in ("device", "api_key", "endpoint"):
        endpoint_kind = "hub" if kind == "endpoint" else kind
        rows = [c for c in listed if str(c.endpoint.kind) == endpoint_kind and c.source.eligible]
        assert rows, f"no eligible {kind} source listed: {[(str(c.endpoint.kind), c.source) for c in listed]}"
        out[kind] = min(c.source.rank for c in rows)
    return out


async def test_the_default_order_is_device_then_key_then_endpoint(monkeypatch) -> None:
    ranks = await _ranks(monkeypatch)
    assert ranks["device"] < ranks["api_key"] < ranks["endpoint"]


async def test_an_endpoint_first_order_outranks_the_device_login(monkeypatch) -> None:
    assert write_instance_pref(PREF_LLM_SOURCE_ORDER, ["endpoint", "device", "api_key"])
    ranks = await _ranks(monkeypatch)
    assert ranks["endpoint"] < ranks["device"] < ranks["api_key"]
    assert str((await _resolve_source(_proc())).endpoint_typeid) == EP1, "the bound endpoint now wins"


async def test_the_ui_comma_string_form_is_read_the_same(monkeypatch) -> None:
    assert write_instance_pref(PREF_LLM_SOURCE_ORDER, "endpoint, device,api_key")
    ranks = await _ranks(monkeypatch)
    assert ranks["endpoint"] < ranks["device"] < ranks["api_key"]


async def test_a_process_or_project_pin_still_wins_over_the_order(monkeypatch) -> None:
    from flow_sdk.builtin.project import Project

    # Most preferred kind is the device login; the pins name hub endpoints anyway.
    assert write_instance_pref(PREF_LLM_SOURCE_ORDER, ["device", "api_key", "endpoint"])
    await _ranks(monkeypatch)  # all three kinds available

    chosen = await _resolve_source(_proc(endpoint=EP2))
    assert chosen.endpoint_typeid == EP2 and str(chosen.origin) == "process"

    project = await Project(name="pinned", llm_endpoint_typeid=EP2).save()
    chosen = await _resolve_source(_proc(project_id=project.id))
    assert chosen.endpoint_typeid == EP2 and str(chosen.origin) == "project"
