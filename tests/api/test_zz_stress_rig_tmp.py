"""TEMPORARY stress rig (never committed): all three phases under load, through the real desktop paths.

Phase 1 — tab placement: one shown tab, many sessions, sequential and concurrent openers.
Phase 2 — scope groups: many connect rounds across groups and an old hub; racing completions; per-source scopes.
Phase 3 — Gmail: the shipped credential is app-password only, and the source logs in with it, many times over.
"""
from __future__ import annotations

import asyncio
import random
from types import SimpleNamespace

import pytest

from flow_sdk.app.actions.oauth_action import _handle_auth, _handle_wait_callback
from flow_sdk.responses.response import ApiSuccessResponse
from tests.api.test_oauth_scope_groups import (  # noqa: F401 — fixtures
    LOCAL_CREDENTIALS_NAME,
    MAIL_LOCAL,
    PROVIDER,
    _isolate_oauth_module_state,
    _stored,
    hub,
    local_dummy_provider,
    user,
)

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(120)]


async def _start(group: str = "", scopes: str = ""):
    params = {k: v for k, v in (("group", group), ("scopes", scopes)) if v}
    started = await _handle_auth(PROVIDER, SimpleNamespace(request_parameters=params, initiator_connection_id=""))
    assert isinstance(started, ApiSuccessResponse), started.message
    return started.data["oauth_request_id"]


# ── phase 2 ──────────────────────────────────────────────────────────────────


async def test_stress_many_rounds_latest_wins_per_group_and_groups_never_cross(hub, user):
    rng = random.Random(7)
    latest = {LOCAL_CREDENTIALS_NAME: None, MAIL_LOCAL: None}
    for i in range(40):
        group = rng.choice(["files", "mail", ""])
        legacy = rng.random() < 0.2
        hub.legacy = legacy
        token = f"tok-{i}-{group or 'none'}-{'legacy' if legacy else 'groups'}"
        granted = ["mail.read"] if group == "mail" and not legacy else ["files.read"]
        request_id = await _start(group)
        hub.complete(request_id, token, granted)
        done = await _handle_wait_callback(PROVIDER, request_id)
        assert done.data["status"] == "success"
        target = MAIL_LOCAL if group == "mail" and not legacy else LOCAL_CREDENTIALS_NAME
        latest[target] = token
        for name, want in latest.items():
            got = await _stored(user, name)
            assert (got or {}).get("access_token") == want, (i, name, got, want)
    hub.legacy = False


async def test_stress_racing_completions_adopt_once_with_the_issued_token(hub, user):
    for i in range(15):
        group = "mail" if i % 2 else "files"
        request_id = await _start(group)
        hub.complete(request_id, f"race-{i}", ["mail.read"] if group == "mail" else ["files.read"])
        results = await asyncio.gather(*(_handle_wait_callback(PROVIDER, request_id) for _ in range(12)))
        assert all(r.data["status"] == "success" for r in results)
        stored = await _stored(user, MAIL_LOCAL if group == "mail" else LOCAL_CREDENTIALS_NAME)
        assert stored["access_token"] == f"race-{i}"


async def test_stress_concurrent_auth_starts_each_get_their_own_group(hub, user):
    groups = ["mail", "files", ""] * 20
    ids = await asyncio.gather(*(_start(g) for g in groups))
    assert len(set(ids)) == len(ids)
    sent = [hub.sessions[i]["group"] for i in ids]
    assert sent == ["mail" if g == "mail" else "" for g in groups], "default and unnamed are the provider's own"


async def test_stress_unknown_groups_never_reach_the_hub(hub, user):
    before = len(hub.auth_calls)
    refused = await asyncio.gather(*(_handle_auth(
        PROVIDER, SimpleNamespace(request_parameters={"group": f"nope-{i}"}, initiator_connection_id="")) for i in range(25)))
    assert all(not isinstance(r, ApiSuccessResponse) for r in refused)
    assert len(hub.auth_calls) == before


async def test_stress_per_source_scopes_for_many_sources_at_once():
    from flow_sdk.core.oauth.wanted_scopes import use_point
    from flow_sdk.ingest.testing import make_data_source

    sources = []
    for i in range(40):
        s = make_data_source(["gdrive", "gcs"][i % 2], read_only=bool(i % 3 == 0),
                             config={"path": "x"} if i % 2 == 0 else {"bucket": "b"})
        await s.save()
        sources.append(s)
    answers = await asyncio.gather(*(use_point("google", str(s.id)) for s in sources))
    for s, (group, scopes) in zip(sources, answers):
        assert group == "drive"
        if s.read_only or s.provider == "gcs":
            assert scopes == [], (s.provider, s.read_only, scopes)
        else:
            assert scopes == ["https://www.googleapis.com/auth/drive"]


# ── phase 1 ──────────────────────────────────────────────────────────────────


async def test_stress_a_shown_tab_follows_each_opener_and_never_duplicates():
    from flow_sdk.builtin.project import Project
    from flow_sdk.builtin.tab import Tab, ensure_tab
    from tests.unit.test_tab_actions_order import P1, _order

    if await Project.get_by_id(P1) is None:
        await Project(id=P1, name="stress-tabs").save()

    sessions = [await ensure_tab(f"stress/session-{i}", project_id=P1) for i in range(12)]
    shown = None
    for opener in random.Random(3).sample(sessions, len(sessions)) * 2:
        shown = await ensure_tab("stress/shown", project_id=P1, after_tab_id=opener.id)
        order = await _order(P1)
        assert order.index(shown.id) == order.index(opener.id) + 1
    await asyncio.gather(*(ensure_tab("stress/shown", project_id=P1, after_tab_id=s.id) for s in sessions))
    order = await _order(P1)
    assert order.count(shown.id) == 1 and len(order) == len(set(order))
    assert len([t for t in await Tab.get_all({"id": shown.id})]) == 1


# ── phase 3 ──────────────────────────────────────────────────────────────────


async def test_stress_gmail_is_app_password_only():
    import json
    from pathlib import Path

    from flow_sdk.schema.data_spec.credential_spec import CredentialSpec

    import flow_sdk

    root = Path(flow_sdk.__file__).parent / "system_projects/flowpad_assistant/agentic-assets/data_driver/gmail"
    spec = CredentialSpec.model_validate(json.loads((root / "agentic-assets/credential/gmail/credential.json").read_text()))
    assert list(spec.vars) == ["GMAIL_ADDRESS", "GMAIL_APP_PASSWORD"] and not any(v.is_oauth for v in spec.vars.values())
    source = (root / "source.py").read_text()
    assert "XOAUTH2" not in source and "GOOGLE_WAY" not in source
