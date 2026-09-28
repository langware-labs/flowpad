"""A local agent deployment's process: a Python file, run in a shell.

A running local deployment IS ``python <file>`` typed into a terminal (a ``Shell``, the same PTY
``flow terminal`` opens) on this machine. The file is plain Python in the code-snippet format — by
default the agent loop itself (``builtin/deployment_loop``: imports hidden, the loop shown) and the
line that runs it, written once next to the instance's other per-deployment state; a deployment's
own ``snippet`` names another. Its stdio is
the terminal, so whoever watches the deployment sees the loop as it works, and can edit the file
and run it again.

**Who is running** is a lock, not a remembered pid: the loop holds ``<id>.lock`` for as long as it
runs and writes its pid into it (``hold``). So a second copy — typed twice, run by hand — sees the
lock and leaves at once; a crashed loop frees it; and asking whether a deployment runs never
mistakes a recycled pid for it. The typed command names the deployment (``python <file> <id>``), so
a loop still importing — before it takes the lock — is found by its command line. The shell stays when the loop ends: its output is the record of
what ran, and ↑ Enter runs it again.
"""
from __future__ import annotations

import os
import shlex
import sys
from pathlib import Path
from typing import IO, Optional

#: The environment variable that tells the loop which deployment it runs (the shell carries it).
DEPLOYMENT_ENV = "FLOW_DEPLOYMENT_ID"

#: ``provider_labels`` key → the deployment's shell (the terminal its process runs in).
SHELL_LABEL = "flowpad.process.shell"

#: The line each deployment's file ends with: the loop above, run as THIS deployment (its lock, its
#: terminal, started again when its channels change — ``agent_loop.main``).
RUN = """
# %% flowpad:init
from flow_sdk.builtin.agent_loop import main

main("{deployment_id}", loop=answer_every_message)
"""


def stock(deployment_id: str) -> str:
    """A new deployment's file: the stock loop's own source (``deployment_loop``, a snippet), then
    the line that runs it for *deployment_id* — what the app runs by default, as editable code."""
    from flow_sdk.builtin import deployment_loop  # noqa: PLC0415

    return Path(deployment_loop.__file__).read_text(encoding="utf-8").rstrip("\n") + "\n" + RUN.format(deployment_id=deployment_id)


def _home() -> Path:
    from flow_sdk.instance_settings import get_instance_settings  # noqa: PLC0415

    return Path(get_instance_settings().logs_dir).parent / "deployments"


def file_of(deployment) -> Path:
    """The Python file *deployment* runs: its own ``snippet``, else its stock file (written now if new)."""
    own = str(getattr(deployment, "snippet", "") or "").strip()
    if own:
        return Path(own)
    path = _home() / f"{deployment.id}.py"
    if not path.is_file():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(stock(str(deployment.id)), encoding="utf-8")
    return path


def _lock_path(deployment_id: str) -> Path:
    return _home() / f"{deployment_id}.lock"


def hold(deployment_id: str) -> Optional[IO[str]]:
    """Take *deployment_id*'s lock for this process's lifetime (keep the returned file open), with
    this pid written in it; ``None`` when another process holds it."""
    import fcntl  # noqa: PLC0415

    path = _lock_path(deployment_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    fh = open(path, "a+", encoding="utf-8")  # noqa: SIM115 — held open on purpose: the lock is the fd
    try:
        fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        fh.close()
        return None
    fh.seek(0)
    fh.truncate()
    fh.write(str(os.getpid()))
    fh.flush()
    return fh


def pid_of(deployment) -> Optional[int]:
    """The pid of the process running *deployment* — the lock's holder, else one started for it and
    not yet holding it — or ``None`` when none runs."""
    import fcntl  # noqa: PLC0415

    path = _lock_path(str(deployment.id))
    if path.is_file():
        with open(path, encoding="utf-8") as fh:
            try:
                fcntl.flock(fh, fcntl.LOCK_EX | fcntl.LOCK_NB)
            except BlockingIOError:
                text = fh.read().strip()
                if text.isdigit():
                    return int(text)
            else:
                fcntl.flock(fh, fcntl.LOCK_UN)
    return _starting(deployment)


def _starting(deployment) -> Optional[int]:
    """The process typed for *deployment* (``… <file> <id>``), still importing. Exactly that tail:
    anything else naming the id — a ``grep``, a script driving the deployment — is not it, and taking
    it for the loop left the deployment dead with nobody starting it."""
    import psutil  # noqa: PLC0415

    tail = [str(file_of(deployment)), str(deployment.id)]
    for proc in psutil.process_iter(["pid", "cmdline"]):
        cmdline = proc.info.get("cmdline") or []
        if cmdline[-2:] == tail and proc.info["pid"] != os.getpid():
            return proc.info["pid"]
    return None


def alive(deployment) -> bool:
    """Whether a process runs *deployment* now."""
    return pid_of(deployment) is not None


def shell_id_of(deployment) -> str:
    return str((getattr(deployment, "provider_labels", None) or {}).get(SHELL_LABEL) or "")


def command_of(deployment) -> str:
    """What is typed into the terminal: this interpreter, on the deployment's file, naming the deployment."""
    return f"{shlex.quote(sys.executable)} {shlex.quote(str(file_of(deployment)))} {deployment.id}"


async def _shell(deployment):
    """The deployment's terminal — the one it had, else a new one — with a live PTY."""
    from flow_sdk.builtin.faas.compute_node import ComputeNode  # noqa: PLC0415
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    shell = await Shell.get_by_id(shell_id_of(deployment)) if shell_id_of(deployment) else None
    if shell is None or shell.status == "closed":
        node = await ComputeNode.get_local()
        shell = Shell(
            compute_node_id=str(node.id),
            compute_node_uname=getattr(node, "uname", None),
            name=f"{deployment.name or 'Deployment'} · process",
            workdir=str(file_of(deployment).parent),
        )
        await shell.save()
    await shell.start_pty(rows=30, cols=120, extra_env={DEPLOYMENT_ENV: str(deployment.id)})
    _pin(shell)
    return shell


def _pin(shell) -> None:
    """The loop must outlive its viewers: its terminal is never reaped as an orphan or evicted."""
    from flow_sdk.compute.providers.desktop.pty_session_manager import pty_registry  # noqa: PLC0415

    pty_registry.pin(str(shell.id))


async def start(deployment) -> dict[str, str]:
    """Type the deployment's command into its terminal; the labels that record the terminal. A copy
    that finds the loop already running leaves at once (the lock), so a start is never a twin."""
    import asyncio  # noqa: PLC0415

    shell = await _shell(deployment)
    await shell.write(command_of(deployment))
    # The command is typed, not yet a process: until the shell has forked it, the next reconcile
    # would see nothing running and type it again — into the loop's stdin, to run the moment the loop
    # ends. So this start is over only once the process exists (or plainly never came up).
    for _ in range(100):
        if await asyncio.to_thread(pid_of, deployment) is not None:
            break
        await asyncio.sleep(0.05)
    return {SHELL_LABEL: str(shell.id)}


def stop(deployment) -> bool:
    """Stop the process running *deployment* and everything under it (the terminal stays, showing
    how it ended); whether nothing of it is left running."""
    import psutil  # noqa: PLC0415

    from flow_sdk.instances.procs import terminate_tree  # noqa: PLC0415

    pid = pid_of(deployment)
    if pid is None:
        return True
    try:
        proc = psutil.Process(pid)
    except psutil.NoSuchProcess:
        return True
    return not terminate_tree([proc])[1]


async def close_shell(deployment) -> None:
    """End the deployment's terminal (a deleted deployment has nothing left to show)."""
    from flow_sdk.builtin.shell import Shell  # noqa: PLC0415

    shell = await Shell.get_by_id(shell_id_of(deployment)) if shell_id_of(deployment) else None
    if shell is not None:
        await shell.close()


__all__ = [
    "DEPLOYMENT_ENV", "SHELL_LABEL", "alive", "close_shell", "command_of", "file_of", "hold", "pid_of",
    "shell_id_of", "start", "stop",
]
