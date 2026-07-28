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
    webapp = await resolve_display_target(port=3000)
    assert webapp == {"kind": DisplayTargetKind.WEBAPP, "port": 3000}

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
