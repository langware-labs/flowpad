"""``interactive_launch_command`` — the line the project list offers to run OUTSIDE.

The whole value of that affordance is being the command we actually run, so what
these pin is the DERIVATION, not the strings: it must come off the vendors' real
``AgentOptions`` (interactive shape, this platform's shell), and it must keep
carrying nothing that only exists once a process does.
"""

from __future__ import annotations

import pytest

from flow_sdk.builtin.agentic_process.cli_drivers.cli_worker_base_driver import (
    factory,
    interactive_launch_command,
)
from flow_sdk.flowpad_types.vendors import VENDORS

WORKDIR = "/tmp/a project"


@pytest.mark.parametrize("worker_type", [v.worker_type for v in VENDORS])
def test_is_the_vendors_own_render_not_a_second_opinion(worker_type: str) -> None:
    """Byte-identical to the options object's own ``to_shell_string()``.

    This is the anti-drift assertion. A hand-mirrored table (the frontend has
    one, for resume) goes stale the first time a vendor changes a flag; deriving
    cannot. If this ever needs its own expected-string list, the derivation has
    been replaced by a copy and the feature has started lying.
    """
    expected = factory({"workdir": WORKDIR, "json_stream": False, "print_mode": False}, worker_type).to_shell_string()
    assert interactive_launch_command(worker_type, WORKDIR) == expected


@pytest.mark.parametrize("worker_type", [v.worker_type for v in VENDORS])
def test_starts_in_the_folder_it_was_asked_about(worker_type: str) -> None:
    """Every vendor line `cd`s first, quoted — the workdir has a space on purpose."""
    assert interactive_launch_command(worker_type, WORKDIR).startswith(f"cd '{WORKDIR}' && ")


@pytest.mark.parametrize("worker_type", [v.worker_type for v in VENDORS])
def test_is_the_interactive_shape_not_the_headless_one(worker_type: str) -> None:
    """Three vendors default to HEADLESS and the spawn path flips them on
    ``process.pty_mode``; there is no process here, so the flag is stated.

    Without that, this would hand a user a `-p` / `--json` command that exits
    instead of the TUI they clicked for. Checked through each vendor's own
    headless markers rather than a flag name, since the name differs per vendor.
    """
    command = interactive_launch_command(worker_type, WORKDIR)
    headless_markers = (" -p ", " --json", "exec ", "--output-format")
    assert not any(marker in f"{command} " for marker in headless_markers), command


@pytest.mark.parametrize("worker_type", [v.worker_type for v in VENDORS])
def test_carries_nothing_that_needs_a_process(worker_type: str) -> None:
    """No session id, no per-process assets. A terminal opened from this line is
    a FRESH session in that folder — it cannot rehydrate a Flowpad worker,
    because the add-dirs/agents/MCP and the spawn env are all process-derived."""
    command = interactive_launch_command(worker_type, WORKDIR)
    for process_only in ("--resume", "--session-id", "--add-dir", "--agents", "--mcp-config", "--fork-session"):
        assert process_only not in command, f"{process_only} in {command}"


def test_unknown_vendor_is_an_error_not_a_guess() -> None:
    """A typo must not silently resolve to the default harness — the caller is
    about to run this in the user's own shell."""
    with pytest.raises(ValueError):
        interactive_launch_command("not_a_harness", WORKDIR)


def test_no_workdir_still_renders() -> None:
    """The renderer's own ``.`` fallback — a bucket with no resolved mount path
    never reaches here (the UI omits the bar), but the function must not raise."""
    assert interactive_launch_command("claude_code", None).startswith("cd . && ")
