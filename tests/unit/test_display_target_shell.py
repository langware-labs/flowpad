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
