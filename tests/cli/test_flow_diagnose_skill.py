"""Structural tests for the flow-diagnose skill.

The skill is agent-facing markdown, so these don't run the agent — they guard the
*wiring* that the agent relies on: the skill exists where `flow diagnose` looks
for it, ships its co-located `report.py` reporter, and Step 7 actually points at
that script (not a deleted `flow_sdk.diagnostics` import / `flow diagnose-report`
CLI). If any of that drifts, the recording step silently breaks at runtime.
"""
import importlib.util

from flow_sdk.config import flowpad_assistant_project_root

# The skill ships inside the package so `flow diagnose` finds it from any cwd.
_SKILL_DIR = flowpad_assistant_project_root() / ".claude" / "skills" / "flow-diagnose"
_SKILL_MD = _SKILL_DIR / "SKILL.md"
_REPORT = _SKILL_DIR / "report.py"


def test_skill_and_reporter_exist():
    assert _SKILL_MD.exists(), f"SKILL.md missing at {_SKILL_MD}"
    assert _REPORT.exists(), f"report.py missing at {_REPORT}"


def test_step7_runs_the_colocated_report_script():
    text = _SKILL_MD.read_text(encoding="utf-8")
    assert "### Step 7" in text, "Step 7 (record the result) must exist"
    # Step 7 must invoke the co-located script...
    assert "report.py" in text, "Step 7 must point at the co-located report.py"
    assert "--attachment-type-id" in text, "Step 7 must pass the diagnosis as an attachment"
    # ...and must NOT resurrect the removed import / CLI paths.
    assert "flow_sdk.diagnostics" not in text
    assert "flow diagnose-report" not in text


def test_reporter_exposes_function_and_cli():
    spec = importlib.util.spec_from_file_location("flow_diagnose_report_struct", _REPORT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert hasattr(mod, "create_diagnostic_report")
    assert hasattr(mod, "_parse_args")
    assert hasattr(mod, "_amain")
    # The CLI contract Step 7 relies on.
    args = mod._parse_args(["--summary", "x"])
    assert args.summary == "x"
    assert hasattr(args, "attachment_type_id")


def test_diagnose_command_targets_this_skill_dir():
    """`flow diagnose` must look for the skill at the path this skill lives in."""
    import inspect

    from flow_sdk.cli.commands import diagnose_cmd

    src = inspect.getsource(diagnose_cmd._run_diagnose)
    assert '"flow-diagnose"' in src or "'flow-diagnose'" in src
