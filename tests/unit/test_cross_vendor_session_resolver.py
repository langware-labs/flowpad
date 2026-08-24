"""Resuming a session by id must work for every vendor, and must not rename one.

Three separate defects made "resume this OpenCode session" impossible, each
invisible on its own:

1. ``terminals/get_by_worker_id/<id>`` lowercased the WHOLE sub-path, so a
   mixed-case id (``ses_ff0351c3fffeknxcJAjTQi4uMp`` — opencode's shape) reached
   the resolver mangled and could never match.
2. ``_resolve_session_record`` scanned claude/codex/copilot only, and the hint
   allowlist 400'd on ``opencode``.
3. The upsert derived the worker type from a ternary chain that DEFAULTED to
   claude — so even a correctly resolved opencode session was written back as a
   ``claude_code`` process, silently, because "unknown" and "claude" shared a
   branch.
"""

from __future__ import annotations

import inspect

import pytest

from flow_sdk.builtin.faas import compute_node, scan_actions
from flow_sdk.flowpad_types.enums import WorkerType


def test_the_route_does_not_lowercase_the_session_id():
    """Case-fold the route prefix, never the id after it."""
    source = inspect.getsource(compute_node.ComputeNode._terminals)
    assert '.strip("/").lower()' not in source, (
        "the sub-path is lowercased wholesale again — this mangles every "
        "case-sensitive session id (opencode's are mixed-case)"
    )
    assert 'raw_sub_path.lower().startswith(prefix)' in source


@pytest.mark.parametrize("hint", ["claude", "codex", "copilot", "opencode"])
def test_every_vendor_is_an_accepted_hint(hint):
    """A rejected hint is a 400, not a fallback — so an omission is fatal."""
    source = inspect.getsource(scan_actions.ScanActionsMixin._scan_get_by_worker_id)
    assert f'"{hint}"' in source


def test_the_resolver_probes_opencode():
    source = inspect.getsource(scan_actions._resolve_session_record)
    assert "opencode" in source
    # And it must not reject the hint before it gets there.
    assert '"opencode"' in source.split("if hint not in")[1].split(")")[0]


def test_unknown_hints_are_still_rejected():
    """The allowlist must stay an allowlist — not become a pass-through."""
    assert scan_actions._resolve_session_record("whatever", hint="nonsense") == (None, None)


def test_worker_type_comes_from_a_table_not_a_claude_defaulting_ladder():
    """The mis-attribution bug: 'unknown vendor' must not resolve to claude."""
    source = inspect.getsource(scan_actions.ScanActionsMixin._upsert_session_process_impl)
    assert "_VENDORS" in source, "the vendor ternary chain is back"
    for vendor in ("codex", "copilot", "opencode"):
        assert f'"{vendor}"' in source
    # Claude remains the documented default for an unlisted vendor, but it is
    # now an explicit `.get(..., default)` rather than an implicit else-branch.
    assert 'WorkerType.CLAUDE_CODE' in source


def test_resume_passes_the_cli_session_id_for_every_non_claude_vendor():
    """Keyed on 'not claude', so a new vendor keeps its --session flag."""
    source = inspect.getsource(scan_actions.ScanActionsMixin._upsert_session_process_impl)
    assert 'cli_factory_key != "claude"' in source
    assert "if is_codex or is_copilot:" not in source


def test_opencode_is_a_real_worker_type():
    """Guards the enum the table maps onto."""
    assert WorkerType.OPENCODE.value == "opencode"


# ---------------------------------------------------------------------------
# The hint must actually SKIP the other backends. The branch guards were
# exclusion lists naming the other vendors, which silently stopped skipping the
# moment a fourth vendor existed: hint="opencode" satisfied all three and probed
# claude, codex and copilot first.
# ---------------------------------------------------------------------------


def _spy(called, name):
    def _fn(*a, **k):
        called.append(name)
        return None

    return _fn


def _patch_all(monkeypatch, called):
    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions.claude_sessions.get_claude_session",
        _spy(called, "claude"),
    )
    monkeypatch.setattr(
        "flow_sdk.fs_store.indexer.functions.codex_sessions.get_codex_session",
        _spy(called, "codex"),
    )
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.copilot.session_history."
        "find_copilot_session_jsonl",
        _spy(called, "copilot"),
    )
    monkeypatch.setattr(
        "flow_sdk.builtin.agentic_process.cli_drivers.opencode.session_history."
        "find_opencode_session",
        _spy(called, "opencode"),
    )


@pytest.mark.parametrize("hint", ["claude", "codex", "copilot", "opencode"])
def test_a_hint_probes_exactly_one_backend(hint, monkeypatch):
    called: list[str] = []
    _patch_all(monkeypatch, called)
    scan_actions._resolve_session_record("some-session-id", hint=hint)
    assert called == [hint], f"hint={hint!r} probed {called}"


def test_no_hint_probes_every_vendor(monkeypatch):
    """The unhinted path must still cover all four, or resume silently 404s."""
    called: list[str] = []
    _patch_all(monkeypatch, called)
    scan_actions._resolve_session_record("some-session-id", hint=None)
    assert set(called) == {"claude", "codex", "copilot", "opencode"}
