"""Phase B equivalence harness for the AgentOptions consolidation.

Characterization test: a frozen golden snapshot of every vendor option builder's
output across a matrix of configs, captured from the PRE-refactor code. The
consolidation must reproduce it byte-for-byte (with ``system_prompt_append``
unset). Pure string-manip ⇒ the whole matrix runs in milliseconds.

Regenerate the golden (only before the refactor, from known-good code):

    uv run python tests/unit/test_cli_options_equivalence.py --regen

Outputs that are machine-dependent are normalized: ``to_spawn_args`` argv[0] is
the claude binary resolved via ``shutil.which`` — we basename it so the golden is
portable.
"""

from __future__ import annotations

import inspect
import json
import os
import shutil
import sys
from pathlib import Path

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli import ClaudeAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.codex.cli import CodexAgentOptions
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.cli import CopilotAgentOptions

GOLDEN = Path(__file__).parent / "fixtures" / "cli_options_golden.json"

_VENDORS = {"claude": ClaudeAgentOptions, "codex": CodexAgentOptions, "copilot": CopilotAgentOptions}

# (config-id, kwargs) per vendor — representative of every flag/branch.
MATRIX: dict[str, list[tuple[str, dict]]] = {
    "claude": [
        ("default", {}),
        ("bypass_session", {"session_id": "s1"}),
        ("resume", {"session_id": "s1", "resume": True}),
        ("fork", {"session_id": "new", "resume": True, "fork_session_id": "src"}),
        ("model_tier_sm", {"model": "sm"}),
        ("model_real", {"model": "claude-opus-4-5"}),
        ("perm_default", {"permission_mode": "default"}),
        ("perm_plan", {"permission_mode": "plan"}),
        ("chrome_debug_worktree", {"chrome": True, "debug": True, "worktree": True}),
        ("print_stream", {"print_mode": True, "output_format": "stream-json"}),
        ("effort", {"effort": "high"}),
        ("agents", {"agents_json": {"rev": {"description": "d", "prompt": "p"}}}),
        ("add_dirs", {"add_dirs": ["/extra", "/extra b"]}),
        ("workdir_env", {"workdir": "/repo", "env_vars": {"FOO": "bar", "K": "v v"}}),
        (
            "full",
            {
                "session_id": "s1",
                "resume": True,
                "model": "sm",
                "permission_mode": "plan",
                "add_dirs": ["/a"],
                "workdir": "/repo",
                "env_vars": {"FOO": "bar"},
                "print_mode": True,
                "output_format": "stream-json",
                "effort": "low",
            },
        ),
    ],
    "codex": [
        ("default", {}),
        (
            "headless_full",
            {
                "session_id": "s1",
                "resume": True,
                "model": "gpt-5.2",
                "workdir": "/repo",
                "add_dirs": ["/extra", "/extra b"],
                "env_vars": {"FOO": "bar"},
            },
        ),
        ("model_tier_sm", {"model": "sm"}),
        (
            "interactive",
            {
                "json_stream": False,
                "model": "gpt-5.2",
                "workdir": "/repo",
                "session_id": "s1",
                "resume": True,
                "add_dirs": ["/extra"],
            },
        ),
        ("interactive_default_perm", {"json_stream": False, "permission_mode": "default"}),
        ("non_ephemeral", {"ephemeral": False}),
        ("skills", {"skill_names": ["reviewer", "bug fixer"], "workdir": "/repo"}),
        ("perm_default", {"permission_mode": "default"}),
    ],
    "copilot": [
        ("default", {}),
        (
            "headless_full",
            {
                "session_id": "abc-123",
                "resume": True,
                "model": "claude-haiku-4.5",
                "workdir": "/repo",
                "add_dirs": ["/extra"],
                "env_vars": {"FOO": "bar"},
                "effort": "high",
            },
        ),
        ("model_tier_lg", {"model": "lg"}),
        ("fresh_session", {"session_id": "new-session"}),
        (
            "interactive",
            {
                "json_stream": False,
                "model": "claude-haiku-4.5",
                "workdir": "/repo",
                "session_id": "abc",
                "resume": True,
            },
        ),
        (
            "flags_off",
            {"no_ask_user": False, "no_auto_update": False, "no_custom_instructions": False, "allow_all": False},
        ),
        ("perm_default", {"permission_mode": "default"}),
        ("skills", {"skill_names": ["x"], "workdir": "/repo"}),
    ],
}

_INSTRUCTIONS = {"none": None, "instr": "fix the bug", "dash": "-rf danger", "multi": "line one\nline two"}

# Both OSes must be frozen: the shell string (_build_posix vs _build_win32) and
# claude's binary wrapping (PLATFORM_WIN32 → COMSPEC) differ by platform, so the
# consolidation must keep Windows output byte-identical too.
_PLATFORMS = ["linux", "win32"]

# Constructor coverage that intentionally stays outside the frozen golden
# matrix.  Adding these cases to MATRIX would require rewriting the historical
# fixture, so the inventory combines both sources instead.
_SUPPLEMENTAL_CONSTRUCTOR_KWARGS: dict[str, dict] = {
    "claude": {"verbose": True, "plugin_dirs": ["/runtime-plugin"]},
    "codex": {"bypass_hook_trust": True},
    "copilot": {
        "custom_instruction_dirs": ["/instructions"],
        "plugin_dirs": ["/runtime-plugin"],
    },
}

_LAUNCH_ONLY_FIELDS: dict[str, set[str]] = {
    "claude": {"system_prompt_append", "system_prompt_file"},
    "codex": {
        "fork_session_id",
        "system_prompt_append",
        "system_prompt_file",
        "developer_instructions",
        "extra_config_overrides",
    },
    "copilot": {"fork_session_id", "system_prompt_append", "system_prompt_file"},
}


def _capture(vendor: str, kwargs: dict, platform: str) -> dict:
    """All output forms for one option config under one mocked OS — the unit of
    equivalence. ``sys.platform`` is set by the caller (regen) or a fixture (test)."""
    sys.platform = platform
    cls = _VENDORS[vendor]
    out: dict = {}
    for ikey, instr in _INSTRUCTIONS.items():
        argv, env = cls(**kwargs).to_spawn_args(instruction=instr)
        argv = [os.path.basename(argv[0]), *argv[1:]] if argv else argv  # normalize binary path
        out[f"spawn_{ikey}"] = {"argv": argv, "env": env}
        out[f"shell_{ikey}"] = cls(**kwargs).to_shell_string(instruction=instr)
    out["json"] = cls(**kwargs).to_json()
    return out


def _regen() -> None:
    real = sys.platform
    try:
        golden: dict = {
            vendor: {cid: {plat: _capture(vendor, kw, plat) for plat in _PLATFORMS} for cid, kw in configs}
            for vendor, configs in MATRIX.items()
        }
    finally:
        sys.platform = real
    GOLDEN.parent.mkdir(parents=True, exist_ok=True)
    GOLDEN.write_text(json.dumps(golden, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    n = sum(len(c) for c in MATRIX.values()) * len(_PLATFORMS)
    print(f"wrote {GOLDEN} ({n} vendor×config×os cells)")


_CASES = [(v, cid, kw, plat) for v, configs in MATRIX.items() for cid, kw in configs for plat in _PLATFORMS]

_SPAWN_CASES = [
    (*case, instruction_key, instruction) for case in _CASES for instruction_key, instruction in _INSTRUCTIONS.items()
]


@pytest.mark.parametrize("vendor,cid,kwargs,platform", _CASES, ids=[f"{v}-{c}-{p}" for v, c, _, p in _CASES])
def test_cli_options_match_golden(vendor, cid, kwargs, platform, monkeypatch):
    monkeypatch.setattr(sys, "platform", platform)  # restored after the test
    # argv[0] is basename-normalized to "claude" in _capture, so PATH resolution
    # is irrelevant to the golden. Stub shutil.which: on Python 3.12+ the real
    # which() dispatches to Windows-only _winapi under a faked sys.platform=="win32"
    # and raises AttributeError on non-Windows hosts. None → _resolve_binary returns
    # ["claude"], reproducing the frozen golden byte-for-byte on every platform.
    monkeypatch.setattr(shutil, "which", lambda *a, **k: None)
    golden = json.loads(GOLDEN.read_text(encoding="utf-8"))
    assert _capture(vendor, kwargs, platform) == golden[vendor][cid][platform], (
        f"{vendor}/{cid}/{platform} diverged from the frozen golden — the consolidation changed output"
    )


@pytest.mark.parametrize(
    "vendor,cid,kwargs,platform,instruction_key,instruction",
    _SPAWN_CASES,
    ids=[f"{v}-{c}-{p}-{key}" for v, c, _kw, p, key, _instruction in _SPAWN_CASES],
)
def test_spawn_contract_preserves_argv_env_and_prompt_channel(
    vendor, cid, kwargs, platform, instruction_key, instruction, monkeypatch
):
    monkeypatch.setattr(sys, "platform", platform)
    monkeypatch.setattr(shutil, "which", lambda *args, **kwargs: None)
    options = _VENDORS[vendor](**kwargs)
    argv, env, stdin = options.to_spawn(instruction=instruction)
    compat_argv, compat_env = options.to_spawn_args(instruction=instruction)

    assert (argv, env) == (compat_argv, compat_env)
    assert stdin == (None if vendor == "claude" else instruction or "")
    if instruction:
        assert (argv[-2:] == ["--", instruction]) is (vendor == "claude")


@pytest.mark.parametrize("vendor", _VENDORS)
def test_cli_option_inventory_covers_constructor_and_instance_fields(vendor):
    cls = _VENDORS[vendor]
    constructor_fields = set(inspect.signature(cls.__init__).parameters) - {"self"}
    matrix_fields = {key for _case, kwargs in MATRIX[vendor] for key in kwargs}
    exercised_fields = matrix_fields | set(_SUPPLEMENTAL_CONSTRUCTOR_KWARGS[vendor])

    assert exercised_fields == constructor_fields

    options = cls(**_SUPPLEMENTAL_CONSTRUCTOR_KWARGS[vendor])
    instance_fields = {"model" if name == "_model" else name for name in vars(options)}
    assert instance_fields == constructor_fields | _LAUNCH_ONLY_FIELDS[vendor]


@pytest.mark.parametrize(
    "options",
    [
        ClaudeAgentOptions(session_id="O'Brien"),
        CodexAgentOptions(model="O'Brien"),
        CopilotAgentOptions(model="O'Brien"),
    ],
    ids=["claude", "codex", "copilot"],
)
def test_win32_renderer_uses_powershell_apostrophe_quoting(options):
    assert "O'Brien" in options.cli_cmd()

    rendered = options._render_shell_string("win32", instruction=None)

    assert "'O''Brien'" in rendered
    assert "'\"'\"'" not in rendered


if __name__ == "__main__":
    if "--regen" in sys.argv:
        _regen()
    else:
        print("pass --regen to (re)capture the golden from current code")
