"""The web-tester skill bootstraps Chromium WITH the system libraries it links against.

A Flowpad sandbox is a slim image: it ships none of Chromium's shared libraries (`libglib`, `libnss3`,
`libX11`, …). `playwright install chromium` downloads the browser and nothing else, so on a sandbox the
browser dies at launch with `error while loading shared libraries: libglib-2.0.so.0` and the skill never
tests anything. `--with-deps` installs those libraries too (Playwright escalates with `sudo` itself).

This pins the TEXT the agent follows, not a browser launch — a proxy. The launch itself was proven on a
real staging sandbox: without the flag the runner exits with that error, with it the sweep passes.
"""

import re
from pathlib import Path

SKILL_PATH = (
    Path(__file__).resolve().parents[2]
    / "flow_sdk/system_projects/flowpad_assistant/.claude/skills/web-tester/SKILL.md"
)


def _install_commands() -> list[str]:
    """Every `playwright install …` invocation in the skill's code fences, line continuations joined."""
    source = SKILL_PATH.read_text(encoding="utf-8")
    fences = re.findall(r"```(?:bash|sh)?\n(.*?)```", source, re.S)
    commands: list[str] = []
    for fence in fences:
        joined = re.sub(r"\\\n\s*", " ", fence)
        commands += re.findall(r"playwright install[^\n&|;]*", joined)
    return commands


def test_the_skill_names_both_bootstrap_paths():
    """The uv path and the venv fallback each install the browser. A vanished command would let the
    test below pass on nothing."""
    assert len(_install_commands()) == 2


def test_every_browser_install_brings_its_system_libraries():
    for command in _install_commands():
        assert "--with-deps" in command.split(), f"installs the browser without its libraries: {command!r}"
