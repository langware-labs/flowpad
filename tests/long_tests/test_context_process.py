"""ContextProcess: a process bound to a message knows the message id from its context.

Real prompt round-trip against a live claude worker: the bound message's id is
inlined in the worker's system prompt (the context summary), so the worker echoes
it WITHOUT reading the message. The worker's answer is found by watching for the
NEW transcript it writes under the real ``~/.claude/projects`` (not the driver's
existence-gated computed path). Registered in this dir's conftest
``_REAL_HOME_TEST_MODULES`` so the CLI subprocess gets the real HOME (creds +
transcript location). Skips when the claude CLI or explicit E2E instance
selector is unavailable; an explicitly selected unsafe target fails closed.
"""

import asyncio
import glob
import os
import shutil

import pytest

pytestmark = pytest.mark.asyncio
MSG_ID = "11111111-1111-4111-8111-111111111111"


@pytest.mark.skipif(shutil.which("claude") is None, reason="claude CLI not installed")
async def test_message_id_echoed_from_context(tmp_path, monkeypatch, resolve_live_e2e_instance):
    primary = resolve_live_e2e_instance("FLOWPAD_E2E_INSTANCE")
    # The spawned claude worker's `flow` hooks must reach a RUNNING backend or it
    # stalls at startup; pytest's `test` instance has none. Target the warm dev
    # instance validated above so the turn is ~4-6s.
    monkeypatch.setenv("FLOW_INSTANCE", primary.name)
    from flow_sdk.builtin.agentic_process.agentic_process import AgenticProcess
    from flow_sdk.builtin.agentic_process.model_tiers import ModelTier
    from flow_sdk.builtin.flow_message import FlowMessage
    from flow_sdk.builtin.graph_context import GraphContext
    from flow_sdk.core.capabilities.discovery import ensure_discovered
    from flow_sdk.migrations.runner import _bootstrap_local

    await _bootstrap_local()
    await ensure_discovered()

    msg = await FlowMessage(id=MSG_ID, text="hello there").save()
    gc = await GraphContext(context_typeids=[str(msg.typeid)]).save()
    ap = AgenticProcess(
        cli_config={"permission_mode": "bypassPermissions", "model": ModelTier.SM.value},
        workdir=str(tmp_path),
        visible=False,
        pty_mode=False,
    )
    ap.set_graph_context(gc)

    # Nested-claude safety: this test runs INSIDE a claude session, and MSG_ID
    # also appears in that parent transcript — so we can't grep all transcripts.
    # Snapshot transcripts BEFORE the prompt and read only the NEW file the child
    # worker creates, identifying it as the worker. Expanded at call time so it
    # uses the real HOME the conftest restores for CLI subprocess tests.
    pattern = os.path.expanduser("~/.claude/projects/*/*.jsonl")
    before = set(glob.glob(pattern))

    res = await ap.prompt("Do NOT use any tools. Answer ONLY with the flow_message id shown in your context summary.")
    assert not getattr(res, "is_error", False), f"prompt failed to start: {res}"

    text = ""
    while MSG_ID not in text:
        for f in set(glob.glob(pattern)) - before:  # only the worker's freshly-created transcript
            t = open(f, encoding="utf-8", errors="replace").read()
            if MSG_ID in t:
                text = t
                break
        await asyncio.sleep(0.5)

    assert MSG_ID in text
