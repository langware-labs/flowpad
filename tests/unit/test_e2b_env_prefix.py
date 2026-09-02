"""The env prefix that carries values into a single command.

One builder now serves every provider. Before that, the E2B copy was annotated
`env: dict[str, str]` and called `.items()`, so the `list[FlowEnv]` that
`ComputeNode.run_command` actually forwards raised AttributeError — the exact
break that "unit tests must pass on both providers" exists to catch.
"""

import subprocess
import sys

import pytest
from pydantic import SecretStr

from flow_sdk.compute.providers.env_prefix import build_env_prefix
from flow_sdk.core.flow.models.execution.env_context import FlowEnv
from tests.unit.conftest import py_command as _py


def _env(**kwargs) -> list[FlowEnv]:
    return [FlowEnv(name=k, value=SecretStr(v)) for k, v in kwargs.items()]


def test_no_env_produces_no_prefix():
    assert build_env_prefix(None) == ""
    assert build_env_prefix([]) == ""
    assert build_env_prefix({}) == ""


def test_posix_prefix_single_quotes_each_value():
    assert build_env_prefix(_env(A="one", B="two"), windows=False) == "A='one' B='two' "


def test_posix_prefix_escapes_embedded_single_quotes():
    """`'\\''` — close, escaped quote, reopen. The only sequence that is safe
    for arbitrary bytes inside single quotes."""
    prefix = build_env_prefix(_env(TOKEN="it's a 'value'"), windows=False)

    assert prefix == "TOKEN='it'\\''s a '\\''value'\\''' "


def test_posix_prefix_leaves_shell_metacharacters_inert():
    prefix = build_env_prefix(_env(V="$(whoami) && rm -rf / | tee `id`"), windows=False)

    # Everything stays inside the quotes; nothing is expanded or chained.
    assert prefix.startswith("V='$(whoami) && rm -rf / | tee `id`'")


def test_secretstr_is_unwrapped_not_stringified():
    """`str(SecretStr(...))` yields '**********' — unwrapping explicitly is what
    keeps the real value from being silently replaced by asterisks."""
    prefix = build_env_prefix(_env(K="real-value"), windows=False)

    assert "real-value" in prefix
    assert "*" not in prefix


def test_windows_prefix_quotes_the_assignment():
    """`set "NAME=value"` — the closing quote terminates the value, which is what
    keeps the ` && ` separator out of it."""
    prefix = build_env_prefix(_env(A="a&b|c<d>e"), windows=True)

    assert prefix == 'set "A=a&b|c<d>e" && '


def test_windows_metacharacters_are_not_caret_escaped():
    """cmd treats `& | < > ^` literally inside the quotes, so escaping them
    there would put literal carets INTO the value."""
    assert build_env_prefix(_env(A="^&"), windows=True) == 'set "A=^&" && '


def test_entries_without_a_name_are_skipped():
    class Nameless:
        name = ""
        value = "x"

    assert build_env_prefix([Nameless()], windows=False) == ""


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_e2b_run_command_accepts_a_flowenv_list(any_provider, compute_provider_kind):
    """The regression: passing a list where a dict was annotated used to raise."""
    if compute_provider_kind != "e2b":
        pytest.skip("regression is specific to the E2B provider")
    provider, node_id = any_provider
    # Read it from a CHILD process, not via $VAR in the command itself: a
    # `VAR=x cmd` prefix applies to the command's environment, but the shell
    # expands the arguments first, so "$VAR" would be empty. (Same reason the
    # hub wraps in `bash -c '...'` where it needs expansion.)
    read_back = _py("import os,sys; sys.stdout.write(os.environ.get('FLOWPAD_E2B_PROBE','<unset>'))")

    cmd = await provider.run_command(node_id, read_back, background=False, env=_env(FLOWPAD_E2B_PROBE="ok"))

    assert cmd.all_stdout.strip() == "ok"
    assert provider.fake_sandbox.last_command.startswith("FLOWPAD_E2B_PROBE='ok' ")


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_e2b_background_flag_is_forwarded_verbatim(any_provider, compute_provider_kind):
    if compute_provider_kind != "e2b":
        pytest.skip("inspects the E2B fake sandbox")
    provider, node_id = any_provider

    await provider.run_command(node_id, "true", background=False)

    assert provider.fake_sandbox.backgrounds == [False]


# ---------------------------------------------------------------------------
# The Windows separator-space defect.
#
# `set NAME=value && cmd` is not an assignment PREFIX — it is a cmd.exe
# statement, and `set` takes the rest of the statement verbatim, INCLUDING the
# space before the `&&`. So every value this builder passes on a Windows node
# arrives with a trailing space. POSIX (line 71) is immune: `NAME='value' cmd`
# is a real assignment prefix whose value the shell delimits on whitespace.
#
# Observed consequence in production: `GIT_INDEX_FILE=<path> ` made every git
# call in `GitFolder._commit` read an EMPTY index (Win32 strips the trailing
# space when CREATING the file, so writes landed on the clean name while reads
# of the space-suffixed path found nothing). `read-tree` seeded nothing, `add`
# staged nothing, `diff --cached` read empty-vs-HEAD as a change, and `commit`
# wrote the empty tree — deleting every file in the repository. The existing
# GitFolder tests never saw it: they drive `_LocalCommandExecutor`, which passes
# env through `subprocess(env=...)`, while production drives
# `ComputeNodeCommandExecutor`, which goes through THIS builder.
# ---------------------------------------------------------------------------

INDEX_PATH = r"C:\repo with space\.git\flowpad-index-2242434178864"


def test_windows_prefix_terminates_the_value_before_the_separator():
    """cmd's only delimiting form is `set "NAME=value"` — the closing quote is
    what keeps the ` && ` separator out of the value."""
    prefix = build_env_prefix(_env(GIT_INDEX_FILE=INDEX_PATH), windows=True)

    assert prefix == f'set "GIT_INDEX_FILE={INDEX_PATH}" && '


@pytest.mark.skipif(sys.platform != "win32", reason="cmd.exe semantics")
def test_windows_prefix_assigns_the_exact_value_in_cmd():
    """The real mechanism, in a real cmd.exe: compose `prefix + command` the way
    `ComputeNodeCommandExecutor.run` does and ask cmd what it actually assigned.

    `set NAME` (no `=`) prints `NAME=value` from cmd's own environment — the
    environment it hands to every child it then runs. Only line endings are
    stripped: a trailing SPACE in the value is the defect under test.
    """
    prefix = build_env_prefix(_env(GIT_INDEX_FILE=INDEX_PATH), windows=True)

    # `shell=True` IS the production invocation: the desktop provider runs the
    # composed string through `asyncio.create_subprocess_shell`
    # (compute/providers/desktop/provider.py:558), which on Windows hands it to
    # cmd.exe verbatim. Passing it as an argv element instead would re-quote it
    # and test Python's quoting rather than cmd's.
    out = subprocess.run(
        prefix + "set GIT_INDEX_FILE", shell=True, capture_output=True, text=True
    ).stdout

    assert out.strip("\r\n") == f"GIT_INDEX_FILE={INDEX_PATH}"
