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
    """The ONE sentinel: built here, read by the browser (``PtyConnection.onText``) by its OSC
    number — invisible escapes around the command (start, then end with the exit code), a cancel
    check at its start, in the grammar of the terminal's shell."""
    import shlex

    assert Shell.SENTINEL_PREFIX == "__flow_" and Shell.SENTINEL_OSC == 7770
    m = "__flow_abc123"
    cancel = shlex.quote(str(Shell.cancel_path(m)))
    start = f"printf '\\033]7770;{m};s\\007'"
    end = f"printf '\\033]7770;{m};%d\\007'"
    guarded = f"if [ -e {cancel} ]; then (exit 130); else ls -la; fi"
    interrupted = shlex.quote(f"printf '\\033]7770;{m};130\\007'; trap - INT")
    assert Shell.sentinel_command("ls -la", m, shell="/bin/bash") == (
        f"trap {interrupted} INT; {start}; {guarded}; {end} $?; trap - INT"
    )
    background = f"if [ -e {cancel} ]; then (exit 130); else sleep 9 & fi"
    assert f"; {background};" in Shell.sentinel_command("sleep 9 &", m, shell="/bin/bash"), "bash refuses '&;'"
    assert Shell.sentinel_command("ls -la", m, shell="/bin/zsh") == f"{{ {start}; {guarded} }} always {{ {end} $? }}"
    assert Shell.sentinel_command("ls", m, shell="/usr/local/bin/fish") == f"{start}; if test -e {cancel}; false; else; ls; end; {end} $status"
    assert Shell.sentinel_command("dir", m, shell="C:/x/pwsh.exe") == (
        f'[Console]::Write("$([char]27)]7770;{m};s$([char]7)"); if (Test-Path {cancel}) {{ }} else {{ dir }}; '
        f'[Console]::Write("$([char]27)]7770;{m};$LASTEXITCODE$([char]7)")'
    )


def test_a_run_cancelled_before_it_starts_skips_its_command_and_still_ends() -> None:
    """What a real shell does with a cancelled line: the command never runs, the end marker prints."""
    import subprocess

    m = "__flow_cancel01"
    cancel = Shell.cancel_path(m)
    cancel.parent.mkdir(parents=True, exist_ok=True)
    cancel.touch()
    try:
        typed = Shell.sentinel_command("echo SHOULD-NOT-RUN", m, shell="sh")
        printed = subprocess.run(["sh", "-c", typed], capture_output=True, check=False).stdout
        assert b"SHOULD-NOT-RUN" not in printed
        assert Shell.sentinel_exit(printed, m)[0] == 130
    finally:
        cancel.unlink(missing_ok=True)


def test_the_sentinel_a_shell_prints_is_read_with_its_exit_code() -> None:
    """What a real shell prints for the posix form: the escape itself, never the typed text —
    the echoed command line holds ``\\033`` as four characters and must not match."""
    import subprocess

    marker = "__flow_abc123"
    typed = Shell.sentinel_command("echo hi; (exit 3)", marker, shell="sh")
    printed = subprocess.run(["sh", "-c", typed], capture_output=True, check=False).stdout
    assert Shell.sentinel_exit(printed, marker) == (3, printed.rindex(b"\x1b]7770"))
    assert Shell.sentinel_output(printed, marker) == b"hi\n"
    assert Shell.sentinel_exit(typed.encode(), marker) is None, "the echoed command is not the sentinel"
    assert Shell.sentinel_exit(printed, "__flow_other") is None


def test_the_output_is_what_lies_between_the_markers_however_the_echo_wraps() -> None:
    """The terminal echoes the typed command — wrapped at its width, redrawn by the line editor —
    before the start marker. Only what comes after it, up to the end marker, is output."""
    marker = "__flow_abc123"
    stream = (
        b"shlom@Mac proj % { printf '\\033]7770;__flow_abc123;s\\007'; ls } al\r\nways { printf '"
        b"\\033]7770;__flow_abc123;%d\\007' $? }\r\n"
        b"\x1b]7770;__flow_abc123;s\x07total 8\r\nfile.txt\r\n\x1b]7770;__flow_abc123;0\x07shlom@Mac proj % "
    )
    assert Shell.sentinel_output(stream, marker) == b"total 8\r\nfile.txt\r\n"
    assert Shell.sentinel_exit(stream, marker)[0] == 0
    running = stream[: stream.index(b"file.txt")]
    assert Shell.sentinel_output(running, marker) == b"total 8\r\n" and Shell.sentinel_exit(running, marker) is None


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
        marker = text.rsplit("7770;", 1)[1].split(";", 1)[0].encode()
        tail = f"{text}\n".encode() + b"\x1b]7770;%s;s\x07" % marker + output.encode()
        if exit_code is not None:
            tail += b"\x1b]7770;%s;%d\x07" % (marker, exit_code)
        stream["data"] += tail

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
