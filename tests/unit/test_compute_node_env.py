"""Compute-node environment variables — real tests.

Drives the public Python provider API (`LocalComputeProvider`):

- `run_command(env=[FlowEnv(...)])` injects vars inline for a single command
  (no persistence, no rc-file writes);
- `set_env(name, value)` persists a var to the shell rc file, `set_env(name, None)`
  removes it, and re-setting updates it — verified by reading the rc file back.

The `set_env` tests redirect `$HOME` to a tmp dir so they never touch the real
`~/.bashrc`. No mocks — real subprocesses via the real provider.
"""

import pytest

from flow_sdk.core.flow.models.execution.env_context import FlowEnv

from tests.unit.conftest import node, py_command as _py  # noqa: F401


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_run_command_env_visible_to_child(node):
    """A var passed via `run_command(env=[...])` is visible to the child process."""
    provider, node_id = node
    env = [FlowEnv(name="FLOWPAD_ENV_PROBE", value="hello-42")]
    read_back = _py("import os,sys; sys.stdout.write(os.environ.get('FLOWPAD_ENV_PROBE',''))")

    cmd = await provider.run_command(node_id, read_back, background=False, env=env)

    assert cmd.exit_code == 0
    assert cmd.all_stdout.strip() == "hello-42"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_run_command_env_does_not_persist(node):
    """The inline-env prefix affects only that one command, not later ones."""
    provider, node_id = node
    env = [FlowEnv(name="FLOWPAD_ENV_ONESHOT", value="present")]
    read_back = _py("import os,sys; sys.stdout.write(os.environ.get('FLOWPAD_ENV_ONESHOT','<unset>'))")

    first = await provider.run_command(node_id, read_back, background=False, env=env)
    assert first.all_stdout.strip() == "present"

    second = await provider.run_command(node_id, read_back, background=False)
    assert second.all_stdout.strip() == "<unset>"


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_env_persists_to_rc(node, tmp_path, monkeypatch):
    """`set_env` writes an `export` line to the (HOME-isolated) rc file."""
    provider, node_id = node
    monkeypatch.setenv("HOME", str(tmp_path))

    await provider.set_env(node_id, "FLOWPAD_PERSIST", "persisted_value")

    rc = tmp_path / ".bashrc"
    assert rc.exists()
    assert "export FLOWPAD_PERSIST='persisted_value'" in rc.read_text()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_env_remove(node, tmp_path, monkeypatch):
    """`set_env(name, None)` removes a previously-set export line."""
    provider, node_id = node
    monkeypatch.setenv("HOME", str(tmp_path))

    await provider.set_env(node_id, "FLOWPAD_REMOVE_ME", "temp")
    rc = tmp_path / ".bashrc"
    assert "export FLOWPAD_REMOVE_ME=" in rc.read_text()

    await provider.set_env(node_id, "FLOWPAD_REMOVE_ME", None)
    assert "export FLOWPAD_REMOVE_ME=" not in rc.read_text()


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_env_update(node, tmp_path, monkeypatch):
    """Re-setting an existing var replaces the old export line, not appends."""
    provider, node_id = node
    monkeypatch.setenv("HOME", str(tmp_path))

    await provider.set_env(node_id, "FLOWPAD_UPDATE", "v1")
    await provider.set_env(node_id, "FLOWPAD_UPDATE", "v2")

    rc_text = (tmp_path / ".bashrc").read_text()
    assert "export FLOWPAD_UPDATE='v2'" in rc_text
    assert "export FLOWPAD_UPDATE='v1'" not in rc_text
    assert rc_text.count("export FLOWPAD_UPDATE=") == 1


@pytest.mark.asyncio
@pytest.mark.timeout(30)  # do not increase timeout without approval
async def test_set_env_special_characters(node, tmp_path, monkeypatch):
    """Values with spaces and single quotes round-trip into the rc file."""
    provider, node_id = node
    monkeypatch.setenv("HOME", str(tmp_path))

    value = "a b 'c' d"
    await provider.set_env(node_id, "FLOWPAD_SPECIAL", value)

    rc_text = (tmp_path / ".bashrc").read_text()
    # get_set_env_cmd escapes ' as '\'' inside a single-quoted export.
    escaped = value.replace("'", "'\\''")
    assert f"export FLOWPAD_SPECIAL='{escaped}'" in rc_text
