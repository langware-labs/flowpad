"""The SHELL display target — an agent's address for the user's terminal.

A terminal is the one display kind that is not RENDERED by the display pane:
the frontend opens its dock and a mounted vibe workspace adopts it as a child
tab, the same way a guided journey's terminal gets there. That only works if
resolution hands back ``kind: 'shell'`` — as a generic entity target the FE
looks for an editor, finds none for ``shell``, and silently shows nothing.

Real entities, real resolver, no PTY (these assert addressing, not I/O).
"""

from __future__ import annotations

import uuid

import pytest

from flow_sdk.builtin.shell import Shell
from flow_sdk.core.display_target import (
    DisplayTargetKind,
    DisplayTargetNotFound,
    resolve_display_target,
    shell_target,
)

pytestmark = pytest.mark.timeout(5)  # do not increase timeout without approval


@pytest.mark.asyncio
async def test_shell_typeid_resolves_to_the_shell_kind() -> None:
    shell = Shell(name="probe-terminal", workdir="/tmp")
    await shell.save()

    payload = await resolve_display_target(typeid=f"shell-{shell.id}")

    assert payload["kind"] == DisplayTargetKind.SHELL, (
        "a shell must not arrive as a generic entity target — the FE has no "
        "editor for `shell` and would render nothing"
    )
    assert payload["id"] == str(shell.id)
    assert payload["typeid"] == f"shell-{shell.id}"
    assert payload["type"] == "shell"
    assert payload["name"] == "probe-terminal"
    assert payload["workdir"] == "/tmp"


@pytest.mark.asyncio
async def test_missing_shell_is_still_not_found() -> None:
    with pytest.raises(DisplayTargetNotFound):
        await resolve_display_target(typeid=f"shell-{uuid.uuid4()}")


@pytest.mark.asyncio
async def test_other_kinds_are_unchanged() -> None:
    # The new branch keys on entity type; everything else must be untouched.
    vfs = await resolve_display_target(path="/tmp/definitely-not-an-indexed-asset.xyz")
    assert vfs["kind"] == DisplayTargetKind.VFS


def test_shell_target_builder_shape() -> None:
    shell = Shell(name="t", workdir="/w")
    payload = shell_target(shell)
    assert set(payload) == {"kind", "typeid", "type", "id", "name", "workdir"}
    assert payload["kind"] == "shell"


def test_sentinel_grammar_is_pinned() -> None:
    """MIRROR of `ui/src/terminal/run-in-terminal.ts`.

    The agent (python) and a guided journey (browser) both assert on a command
    by appending this exact echo. If either side edits the format, the other
    stops recognising the sentinel and every assertion hangs — so both pin the
    literal shape.
    """
    assert Shell.SENTINEL_PREFIX == "__flow_"
    assert Shell.sentinel_command("ls -la", "__flow_abc123") == 'ls -la; echo "__flow_abc123_$?"'


def test_sentinel_body_drops_the_echoed_command() -> None:
    """The terminal echoes what was typed, and what was typed ENDS in the
    sentinel echo — so the first marker-bearing line is the echo, never output.
    Without dropping it, every captured result is prefixed by the command that
    produced it."""
    from flow_sdk.builtin.shell import _sentinel_body

    marker = "__flow_abc123"
    stream = (
        f'shlom@Mac proj % ls -la; echo "{marker}_$?"\n'
        "total 8\n"
        "drwxr-xr-x  2 shlom  staff   64 Jul 27 20:31 .\n"
        f"{marker}_0\n"
    )
    end = stream.index(f"{marker}_0")

    body = _sentinel_body(stream, marker, end)

    assert "echo" not in body, "the echoed command must not be reported as output"
    assert body.splitlines()[0] == "total 8"
    assert body.splitlines()[-1].endswith(" .")


def test_strip_pty_keeps_line_structure() -> None:
    # Unlike strip_pty_controls (which flattens everything for marker search),
    # captured output must stay readable.
    from flow_sdk.builtin.shell import _strip_pty_keep_lines

    raw = b"\x1b[0m\x1b[32mfile.txt\x1b[0m\r\nsecond\r\n"
    assert _strip_pty_keep_lines(raw) == "file.txt\nsecond\n"


# ── run_and_capture answers with a CliResult ──────────────────────────────────
# The PTY itself is faked at `read`/`write` (the terminal's two I/O seams); the
# sentinel parsing and the answer are the real code.


def _fake_terminal(monkeypatch, *, output: str, exit_code: "int | None"):
    """A terminal whose stream grows by `output` (+ sentinel) once a command is typed."""
    stream = {"data": b"prompt % "}

    async def read(self) -> bytes:
        return stream["data"]

    async def write(self, text: str) -> None:
        marker = text.rsplit('echo "', 1)[1].split("_$?")[0]
        tail = f"{text}\n{output}"
        if exit_code is not None:
            tail += f"{marker}_{exit_code}\n"
        stream["data"] += tail.encode()

    monkeypatch.setattr(Shell, "read", read)
    monkeypatch.setattr(Shell, "write", write)


@pytest.mark.asyncio
async def test_run_and_capture_answers_with_a_cli_result(monkeypatch) -> None:
    from flow_sdk.schema.data_spec.returned_value_spec import CliResult, ExitCode

    _fake_terminal(monkeypatch, output="hello\n", exit_code=3)
    shell = Shell(name="t", workdir="/tmp")

    answer = await shell.run_and_capture("echo hello; exit 3", timeout=2, poll_interval=0.01)

    assert isinstance(answer, CliResult)
    assert answer.stdout.strip() == "hello"
    assert answer.returncode == 3
    assert answer.exit_code is ExitCode.NOT_YET
    assert answer.command == "echo hello; exit 3"
    assert answer.executor == f"shell-{shell.id}"


@pytest.mark.asyncio
async def test_run_and_capture_that_outlives_the_wait_is_timed_out(monkeypatch) -> None:
    _fake_terminal(monkeypatch, output="still going\n", exit_code=None)
    shell = Shell(name="t", workdir="/tmp")

    answer = await shell.run_and_capture("sleep 100", timeout=0.05, poll_interval=0.01)

    # Still running in the user's terminal: no exit status, the output so far.
    assert answer.timed_out is True
    assert answer.returncode is None
    assert answer.ok is False
    assert "still going" in answer.stdout


@pytest.mark.asyncio
async def test_run_and_capture_without_a_terminal_is_returned_not_raised(monkeypatch) -> None:
    async def read(self) -> bytes:
        return b""

    async def write(self, text: str) -> None:
        raise RuntimeError("No PTY session — call start_pty() first")

    monkeypatch.setattr(Shell, "read", read)
    monkeypatch.setattr(Shell, "write", write)
    shell = Shell(name="t", workdir="/tmp")

    answer = await shell.run_and_capture("ls", timeout=1)

    assert answer.returncode is None
    assert answer.ran is False
    assert "No PTY session" in answer.stderr
