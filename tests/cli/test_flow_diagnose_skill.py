"""Structural tests for the flow-diagnose skill.

The skill is agent-facing markdown, so these don't run the agent — they guard the
*wiring* that the agent relies on: the skill exists where `flow diagnose` looks
for it, ships its co-located `report.py` reporter, and Step 7 actually points at
that script (not a deleted `flow_sdk.diagnostics` import / `flow diagnose-report`
CLI). If any of that drifts, the recording step silently breaks at runtime.
"""

import importlib.util
import re
import shlex
import subprocess

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
    # Step 7 must invoke the co-located script with the diagnosis fields...
    assert "report.py" in text, "Step 7 must point at the co-located report.py"
    assert "--title" in text, "Step 7 must pass the diagnosis fields to report.py"
    assert "--status" in text, "Step 7 must pass a status to report.py"
    # ...and must NOT resurrect the removed import / CLI paths.
    assert "flow_sdk.diagnostics" not in text
    assert "flow diagnose-report" not in text


def test_reporter_exposes_function_and_cli():
    spec = importlib.util.spec_from_file_location("flow_diagnose_report_struct", _REPORT)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    assert hasattr(mod, "record_diagnosis")
    assert hasattr(mod, "create_support_conversation")
    assert hasattr(mod, "_parse_args")
    assert hasattr(mod, "_amain")
    # The CLI contract Step 7 relies on: --title is the required diagnosis field.
    args = mod._parse_args(["--title", "x", "--status", "ok"])
    assert args.title == "x"
    assert args.status == "ok"


def test_diagnose_command_targets_this_skill_dir():
    """`flow diagnose` must look for the skill at the path this skill lives in."""
    import inspect

    from flow_sdk.cli.commands import diagnose_cmd

    src = inspect.getsource(diagnose_cmd._run_diagnose)
    assert '"flow-diagnose"' in src or "'flow-diagnose'" in src


# ── Step 7 must actually be runnable, not merely well-formed ─────────────────
# The structural tests above pass while the recording step is dead: they check
# that Step 7 *names* report.py, never that the command it prescribes can run.
# It cannot, off the dev checkout. `uv run` resolves an interpreter by walking
# up from the CWD for a pyproject.toml/pyvenv.cfg — it ignores PATH — and a
# diagnose worker's CWD is a user workspace, so uv falls back to its own
# managed Python, which has no Flowpad in it and dies on report.py's first
# import. The one CWD where it works is a flowpad checkout, which happens to BE
# a uv project, so the failure is invisible from the inside.


def _step7_interpreter_argv(env: dict[str, str]) -> list[str]:
    """The tokens Step 7 puts BEFORE report.py, resolved against ``env``.

    Read out of SKILL.md rather than hardcoded: the defect is that the command
    the skill hands the agent cannot run, so the test has to be bound to that
    text. Scoped to Step 7's own fenced block so prose mentioning report.py
    can't be mistaken for the invocation, and to the ``bash`` block
    specifically — Step 7 also carries a PowerShell variant (here-string
    quoting for ``--details``) that this subprocess harness cannot execute.
    """
    text = _SKILL_MD.read_text(encoding="utf-8")
    section = text[text.index("### Step 7") :]
    section = section[: section.index("\n## ")]
    blocks = [
        body
        for lang, body in re.findall(r"```([a-z]*)\n(.*?)```", section, re.DOTALL)
        if lang == "bash" and "report.py" in body
    ]
    assert len(blocks) == 1, f"expected one Step 7 bash block naming report.py, got {len(blocks)}"

    line = next(ln for ln in blocks[0].splitlines() if "report.py" in ln)
    tokens = shlex.split(line.rstrip().rstrip("\\").strip(), posix=True)
    prefix = tokens[: next(i for i, t in enumerate(tokens) if t.endswith("report.py"))]
    assert prefix, f"Step 7 names no interpreter before report.py: {line!r}"

    def resolve(token: str) -> str:
        var = re.fullmatch(r"\$\{?(\w+)\}?", token)
        if not var:
            return token
        value = env.get(var.group(1))
        assert value, f"Step 7 invokes ${var.group(1)}, which the worker environment does not define"
        return value

    return [resolve(t) for t in prefix]


async def _diagnose_worker_env() -> dict[str, str]:
    """The environment a real diagnose worker is spawned with.

    Assembled through the product's own chain, not by hand:
    ``_build_diagnose_process`` is what `flow diagnose` launches,
    ``apply_worker_env`` is the single chokepoint every spawn path calls, and
    ``ClaudeCLIWorker.build_env`` is what turns that into the subprocess env.

    ``VIRTUAL_ENV`` is then dropped, because this test process is the exception
    rather than the rule: it runs under ``uv run pytest`` from the dev checkout,
    so it carries a ``VIRTUAL_ENV`` pointing at ``.venv`` — and that variable is
    the one thing that would let ``uv run`` find Flowpad from an unrelated
    directory. A shipped backend is a uv *tool* install
    (``…/uv/tools/flowpad/``), which is never an activated virtualenv, so its
    workers inherit none. Keeping it here would test the developer's tree
    instead of the product, and pass while every real install fails.
    """
    from flow_sdk.builtin.agentic_process.cli_drivers import apply_worker_env
    from flow_sdk.builtin.agentic_process.cli_drivers.claude.cli_worker import ClaudeCLIWorker
    from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import AgenticContext
    from flow_sdk.cli.commands.diagnose_cmd import _build_diagnose_process

    process = await _build_diagnose_process()
    env_vars = apply_worker_env(dict((process.cli_config or {}).get("env_vars") or {}), process)
    env = ClaudeCLIWorker.build_env(AgenticContext(workdir=process.workdir, env_vars=env_vars))
    env.pop("VIRTUAL_ENV", None)
    return env


async def test_step7_command_runs_report_py_from_a_non_project_cwd(tmp_path):
    """Run Step 7's command, verbatim, from a workdir that is not a uv project.

    ``tmp_path`` stands in for a user workspace: no pyproject.toml, no .venv,
    nothing up the tree — the condition every shipped install runs under. The
    script is expected to exit non-zero here (no ``--title``); what must not
    happen is dying at its first import, which is the recording step failing.
    """
    env = await _diagnose_worker_env()
    assert not (tmp_path / "pyproject.toml").exists() and not (tmp_path / ".venv").exists()

    argv = [*_step7_interpreter_argv(env), str(_REPORT)]
    proc = subprocess.run(argv, cwd=tmp_path, env=env, capture_output=True, text=True)

    # Assert on REACHING argparse, not on the absence of the import error. The
    # reporter guards its flow_sdk import and exits with guidance, so "no
    # ModuleNotFoundError in stderr" would go green on a broken interpreter
    # purely because the message was reworded. Getting as far as "--title is
    # required" is only possible once the import has already succeeded.
    assert "the following arguments are required: --title" in proc.stderr, (
        "Step 7's command never reached report.py's argument parsing, so its flow_sdk "
        "import did not survive and the diagnosis is never recorded.\n"
        f"  command: {shlex.join(argv)}\n"
        f"  cwd:     {tmp_path}\n"
        f"  stderr:  {proc.stderr.strip()}"
    )
