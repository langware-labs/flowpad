"""The env prefix that carries values into a single command.

One builder now serves every provider. Before that, the E2B copy was annotated
`env: dict[str, str]` and called `.items()`, so the `list[FlowEnv]` that
`ComputeNode.run_command` actually forwards raised AttributeError — the exact
break that "unit tests must pass on both providers" exists to catch.
"""

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


def test_windows_prefix_uses_set_and_caret_escapes():
    prefix = build_env_prefix(_env(A="a&b|c<d>e"), windows=True)

    assert prefix == "set A=a^&b^|c^<d^>e && "


def test_windows_caret_is_escaped_first():
    """Escaping `^` last would double-escape the carets the other replacements
    just introduced."""
    assert build_env_prefix(_env(A="^&"), windows=True) == "set A=^^^& && "


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
