"""RCA capture: user-scope sniffer install contaminates the real ~/.claude.

Proven root cause: ``BaseInstanceSettings`` resolves ``flow_home`` from
``FLOW_HOME`` and ``claude_home`` from ``Path.home()`` *independently*
(base_settings.py:285 vs :289), and the instance-settings cache is keyed by
``(name, flow_home)`` only — ``claude_home`` is not part of the key. So when a
process isolates flow data via ``FLOW_HOME`` but keeps the real ``HOME`` and
leaves ``FLOWPAD_CLAUDE_HOME`` unset, the sniffer wrapper is written under the
sandbox ``flow_home`` while the hook entries are written into the *real*
``~/.claude/settings.json``.

This drives the real production path (``FLOW_INSTANCE`` forces a non-"test"
instance so ``BaseInstanceSettings.from_env`` runs — ``TestInstanceSettings``
co-locates both homes under one sandbox and cannot reproduce the divergence).
``real_home`` is a temp stand-in for ``Path.home()`` so the user's actual
``~/.claude`` is never touched; it plays the exact role the bug leaks into.
"""

import pytest

from flow_sdk.builtin.agent_hook import AgentHook, AgentProvider, HookScope
from flow_sdk.builtin.claude_settings_sync import sync_sniffer_hook_to_settings
from flow_sdk.instance_settings import get_instance_settings, reset_instance_settings


@pytest.mark.xfail(
    strict=True,
    reason=(
        "KNOWN BUG: BaseInstanceSettings resolves flow_home (FLOW_HOME) and "
        "claude_home (Path.home()) independently, so a FLOW_HOME-isolated process "
        "with the real HOME leaks the user-scope sniffer install into the real "
        "~/.claude/settings.json. xfail(strict) keeps the suite green until the "
        "resolver divergence is fixed, then flips to a failure to flag the fix."
    ),
)
async def test_sniffer_install_does_not_contaminate_real_claude_settings(tmp_path, monkeypatch):
    real_home = tmp_path / "real_home"            # stands in for the user's real $HOME
    sandbox_flow = tmp_path / "sandbox" / ".flow"  # the FLOW_HOME isolation
    real_home.mkdir(parents=True)
    sandbox_flow.mkdir(parents=True)

    # Production instance: FLOW_INSTANCE wins over PYTEST detection, so the real
    # BaseInstanceSettings resolvers (the divergent ones) run.
    monkeypatch.setenv("FLOW_INSTANCE", "oss")
    monkeypatch.setenv("FLOW_HOME", str(sandbox_flow))
    monkeypatch.setenv("HOME", str(real_home))
    monkeypatch.delenv("FLOWPAD_CLAUDE_HOME", raising=False)

    reset_instance_settings()
    try:
        settings = get_instance_settings()

        # The on/off switch, observed: flow_home follows FLOW_HOME (sandbox) but
        # claude_home falls back to Path.home() (real home) — they diverge.
        real_claude_settings = real_home / ".claude" / "settings.json"
        assert settings.flow_home == sandbox_flow, settings.flow_home
        assert settings.claude_settings_json_path == real_claude_settings, (
            settings.claude_settings_json_path
        )

        assert not real_claude_settings.exists()  # clean real home: nothing there yet

        hook = AgentHook(
            name="flowpad_sniffer",
            hook_name="flowpad_sniffer",
            provider=AgentProvider.CLAUDE_CODE,
            hook_scope=HookScope.USER,
            event="UserPromptSubmit",
        )
        assert hook.id, "AgentHook must have an id for the sniffer marker"

        ok = await sync_sniffer_hook_to_settings(hook)
        assert ok, "sniffer sync reported failure"

        # INVARIANT: isolating flow data via FLOW_HOME must not write into the
        # real ~/.claude. Expecting no change in real claude settings.
        assert not real_claude_settings.exists(), (
            "expecting no change in real claude settings, but the user-scope "
            f"sniffer install wrote {real_claude_settings} — sniffer hooks "
            "leaked into the real home despite FLOW_HOME isolation"
        )
    finally:
        reset_instance_settings()
