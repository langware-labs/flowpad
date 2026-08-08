"""Pins the two properties that let one caller run on either substrate.

``CommandExecutor`` exists so git logic can be written once and run locally or on
a compute node. That only holds if both implementations agree on the two things
that are easy to get subtly different:

* **argv is never shell-interpreted.** A path or branch name containing ``;`` or
  ``$(...)`` must reach the program as one literal argument. Locally that means
  never ``shell=True``; remotely it means the executor does the quoting, because
  ``ComputeNode.run_command`` takes a string. A mock cannot tell you this — the
  local leg has to actually spawn a process, and the remote leg has to be
  inspected for the exact string it would send.
* **``env`` is an additive overlay.** A remote node can only prepend assignments
  to a command, so "replace the environment" is not expressible there. Both legs
  therefore mean "these variables on top of what the target already has". If the
  local leg ever passed ``env`` straight to ``subprocess``, PATH would vanish and
  the divergence would only show up on one substrate.

The remote leg is exercised through a stub node that records the command string.
That is deliberate: this module's job is argv -> shell string and CLICommand ->
CommandResult. Real remote IO belongs to the provider's own tests.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

from flow_sdk.builtin.faas.command_executor import ComputeNodeCommandExecutor
from flow_sdk.utils.command_executor import CommandResult, LocalCommandExecutor

pytestmark = [pytest.mark.asyncio, pytest.mark.timeout(30)]  # do not increase timeout without approval


# ---------------------------------------------------------------------------
# LocalCommandExecutor
# ---------------------------------------------------------------------------


async def test_run_captures_stdout_and_exit_code():
    result = await LocalCommandExecutor().run([sys.executable, "-c", "print('hi')"])
    assert result.returncode == 0
    assert result.ok is True
    assert result.stdout.strip() == "hi"


async def test_run_captures_stderr_and_failure():
    result = await LocalCommandExecutor().run(
        [sys.executable, "-c", "import sys; sys.stderr.write('boom'); sys.exit(3)"]
    )
    assert result.returncode == 3
    assert result.ok is False
    assert "boom" in result.stderr


async def test_argv_is_not_shell_interpreted(tmp_path: Path):
    """The security property. If argv reached a shell, the `;` would run `touch`
    and the file would exist."""
    sentinel = tmp_path / "PWNED"
    hostile = f"; touch {sentinel}"

    result = await LocalCommandExecutor().run([sys.executable, "-c", "import sys; print(sys.argv[1])", hostile])

    assert result.stdout.strip() == hostile, "argument was mangled by a shell"
    assert not sentinel.exists(), "SECURITY: argv was shell-interpreted"


async def test_run_honours_cwd(tmp_path: Path):
    result = await LocalCommandExecutor().run(
        [sys.executable, "-c", "import os; print(os.getcwd())"], cwd=str(tmp_path)
    )
    assert Path(result.stdout.strip()).resolve() == tmp_path.resolve()


async def test_env_is_an_additive_overlay():
    """The variable is set AND the ambient environment survives."""
    script = "import os; print(os.environ.get('FLOWPAD_TEST_VAR', '')); print(bool(os.environ.get('PATH')))"
    result = await LocalCommandExecutor().run([sys.executable, "-c", script], env={"FLOWPAD_TEST_VAR": "overlay"})
    value, has_path = result.stdout.strip().splitlines()
    assert value == "overlay"
    assert has_path == "True", "ambient environment was replaced instead of extended"


async def test_missing_binary_returns_a_result_not_an_exception():
    result = await LocalCommandExecutor().run(["flowpad-definitely-not-a-real-binary"])
    assert result.returncode == 127
    assert result.ok is False


async def test_timeout_returns_a_result_not_an_exception():
    result = await LocalCommandExecutor().run([sys.executable, "-c", "import time; time.sleep(10)"], timeout=1)
    assert result.returncode == 124
    assert result.ok is False


async def test_file_primitives_round_trip(tmp_path: Path):
    executor = LocalCommandExecutor()
    target = tmp_path / "nested" / "deep" / "file.bin"

    assert await executor.exists(str(target)) is False
    await executor.write_bytes(str(target), b"payload")  # parents created on the way
    assert await executor.exists(str(target)) is True
    assert await executor.read_bytes(str(target)) == b"payload"
    assert await executor.is_dir(str(target)) is False
    assert await executor.is_dir(str(target.parent)) is True
    assert await executor.list_dir(str(target.parent)) == ["file.bin"]

    await executor.remove(str(target))
    assert await executor.exists(str(target)) is False


async def test_remove_deletes_a_directory_tree(tmp_path: Path):
    executor = LocalCommandExecutor()
    tree = tmp_path / "tree"
    await executor.write_bytes(str(tree / "a" / "b.txt"), b"x")

    await executor.remove(str(tree))

    assert await executor.exists(str(tree)) is False


async def test_list_dir_of_a_missing_path_is_empty_not_an_error(tmp_path: Path):
    assert await LocalCommandExecutor().list_dir(str(tmp_path / "nope")) == []


async def test_resolve_works_on_a_path_that_does_not_exist_yet(tmp_path: Path):
    """A caller resolves first and decides after; strict resolution would make
    containment checks impossible for a path about to be created."""
    resolved = await LocalCommandExecutor().resolve(str(tmp_path / "a" / ".." / "b"))
    assert resolved == str((tmp_path / "b").resolve())


async def test_make_dirs_is_idempotent(tmp_path: Path):
    executor = LocalCommandExecutor()
    await executor.make_dirs(str(tmp_path / "d"))
    await executor.make_dirs(str(tmp_path / "d"))
    assert await executor.is_dir(str(tmp_path / "d")) is True


# ---------------------------------------------------------------------------
# ComputeNodeCommandExecutor — argv -> shell string, CLICommand -> CommandResult
# ---------------------------------------------------------------------------


def _stub_node(path_sep: str = "/", *, stdout: str = "", stderr: str = "", exit_code: int = 0):
    """Records the exact command string the executor would send."""
    sent: list[str] = []

    async def run_command(command, session_id=None, background=True, env=None):
        sent.append(command)
        return SimpleNamespace(all_stdout=stdout, all_stderr=stderr, exit_code=exit_code)

    node = SimpleNamespace(
        compute_provider=SimpleNamespace(path_sep=path_sep),
        run_command=run_command,
    )
    return node, sent


async def test_remote_quotes_every_argument():
    node, sent = _stub_node()
    await ComputeNodeCommandExecutor(node).run(["git", "commit", "-m", "a message; rm -rf /"])

    assert sent[0] == "git commit -m 'a message; rm -rf /'"


async def test_remote_prefixes_cwd():
    node, sent = _stub_node()
    await ComputeNodeCommandExecutor(node).run(["git", "status"], cwd="/work/my repo")

    assert sent[0] == "cd '/work/my repo' && git status"


async def test_remote_prefixes_env_as_an_overlay():
    node, sent = _stub_node()
    await ComputeNodeCommandExecutor(node).run(["git", "fetch"], env={"FLOWPAD_GIT_TOKEN": "s3cret"})

    # Assignments prepended to the command — the node's own environment is untouched.
    assert sent[0] == "FLOWPAD_GIT_TOKEN='s3cret' git fetch"


async def test_remote_maps_the_cli_command_to_a_result():
    node, _ = _stub_node(stdout="out", stderr="err", exit_code=2)
    result = await ComputeNodeCommandExecutor(node).run(["git", "status"])

    assert result == CommandResult(returncode=2, stdout="out", stderr="err")


async def test_remote_windows_uses_cmd_quoting_and_cd_slash_d():
    node, sent = _stub_node(path_sep="\\")
    await ComputeNodeCommandExecutor(node).run(["git", "add", "a file.txt"], cwd=r"C:\work\repo")

    expected_cwd = subprocess.list2cmdline([r"C:\work\repo"])
    assert sent[0] == f"cd /d {expected_cwd} && git add \"a file.txt\""


async def test_remote_is_dir_reads_the_parent_listing():
    node, _ = _stub_node()

    async def list_dir(paths):
        return {"/work": [SimpleNamespace(name="repo", is_dir=True), SimpleNamespace(name="a.txt", is_dir=False)]}

    node.list_dir = list_dir
    executor = ComputeNodeCommandExecutor(node)

    assert await executor.is_dir("/work/repo") is True
    assert await executor.is_dir("/work/a.txt") is False
    assert await executor.is_dir("/work/missing") is False


async def test_remote_read_bytes_joins_the_stream():
    node, _ = _stub_node()

    async def read_files(paths, file_format="text"):
        async def chunks():
            yield b"one"
            yield b"two"

        return {paths: chunks()}

    node.read_files = read_files

    assert await ComputeNodeCommandExecutor(node).read_bytes("/work/f.bin") == b"onetwo"


async def test_both_executors_satisfy_the_protocol():
    """Structural check — a missing method must fail here, not at a remote call site."""
    from flow_sdk.utils.command_executor import CommandExecutor

    node, _ = _stub_node()
    assert isinstance(LocalCommandExecutor(), CommandExecutor)
    assert isinstance(ComputeNodeCommandExecutor(node), CommandExecutor)


if __name__ == "__main__":
    pytest.main([__file__, "-v"])
