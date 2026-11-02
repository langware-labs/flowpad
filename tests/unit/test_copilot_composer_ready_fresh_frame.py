"""Copilot CLI 1.0.103: the composer-ready gate must recognise a fresh composer.

A fresh interactive Copilot 1.0.103 session (folder trust bypassed by COPILOT_ALLOW_ALL) draws its composer with
the status line below and no ``Session: <n> AIC used`` text. ``CopilotDriver.pty_composer_ready_pattern`` only
matches that text, so ``prompt()`` waits for a composer it never sees: the prompt is never typed and every PTY
Copilot long test (markdown index, skill transcript, settings-instruction PTY) ends without a transcript.
"""
from flow_sdk.builtin.agentic_process.cli_drivers.copilot.driver import CopilotDriver

#: the bottom of a real CLI 1.0.103 PTY frame, captured after the composer drew (ANSI stripped)
FRESH_COMPOSER_FRAME = (
    " ● Tip: /plugin\n"
    " └ Manage plugins and plugin marketplaces\n"
    " ← open sidebar · Interactive · Allow All · / commands · ? help · tab next tab\n"
)


def test_a_fresh_copilot_composer_frame_counts_as_ready():
    assert CopilotDriver.pty_composer_ready_pattern.search(FRESH_COMPOSER_FRAME), (
        "the composer is on screen but the ready pattern does not match it"
    )


#: the same status line on an 80-column PTY: the CLI cuts it after "/ commands"
NARROW_COMPOSER_FRAME = " ● Loading: 2 skills\n ← open sidebar · Interactive · Allow All · / commands\n"

TRUST_SCREEN = " Confirm folder trust\n Do you trust the files in this folder?\n ❯ 1. Yes\n ↑/↓ to navigate · enter to select · esc to cancel\n"


def test_a_narrow_copilot_composer_frame_counts_as_ready():
    assert CopilotDriver.pty_composer_ready_pattern.search(NARROW_COMPOSER_FRAME)


def test_the_folder_trust_screen_is_not_a_ready_composer():
    assert not CopilotDriver.pty_composer_ready_pattern.search(TRUST_SCREEN)
