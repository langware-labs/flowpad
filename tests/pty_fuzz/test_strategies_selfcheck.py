"""Self-validation for the PTY fuzzer content strategies.

Each strategy in ``strategies.sh`` claims to produce a specific class of
terminal output (colors, cursor moves, ink-style repaints, ...). Before any
strategy is used in the replay-equivalence matrix, this suite proves it:

1. runs the strategy inside a *real PTY* (ptyprocess) at a fixed size,
2. captures the raw byte stream a terminal would receive,
3. asserts the expected escape patterns actually appear in the bytes.

The harness — not bash — owns resize schedules and chunk-split schedules;
those axes are exercised in the replay-equivalence tests, not here.
"""

from __future__ import annotations

import os
import re
import sys
from pathlib import Path

import pytest

if sys.platform == "win32":
    pytest.skip("self-check harness drives bash via ptyprocess (POSIX)", allow_module_level=True)

from ptyprocess import PtyProcess

STRATEGIES_SH = Path(__file__).parent / "strategies.sh"

ESC = b"\x1b"
CSI = re.escape(ESC + b"[")

# Per-strategy validation: byte regexes that MUST appear in the captured
# PTY stream. A strategy that fails its own contract is useless as a fuzz
# input — the matrix would silently lose coverage.
EXPECTATIONS: dict[str, list[bytes]] = {
    "plain_lines": [
        rb"plain line 001",
        rb"plain line 040",
        rb"quick brown fox",
    ],
    "ansi_colors": [
        CSI + rb"31mfg-16",                      # 16-color
        CSI + rb"38;5;201mfg-256",               # 256-color
        CSI + rb"38;2;255;100;0mtruecolor",      # truecolor fg
        CSI + rb"48;2;0;60;120m",                # truecolor bg
    ],
    "cursor_moves": [
        CSI + rb"H" + rb"HOME-OVERWRITE",        # CUP home then overwrite
        CSI + rb"3;5H",                          # CUP absolute
        CSI + rb"2A",                            # CUU
        CSI + rb"10C",                           # CUF
        CSI + rb"5D",                            # CUB
    ],
    "erase_repaint": [
        CSI + rb"5A",                            # cursor-up N between frames
        CSI + rb"2K",                            # erase line
        rb"frame 01 row 1",
        rb"frame 12 row 4",
        ("─" * 30).encode(),                     # 90-char divider (wraps at <90 cols)
        rb"erase-repaint done",
    ],
    "cr_overwrite": [
        rb"\rprogress: {1,3}\d+%",               # CR-led repaints, no LF
        rb"[#.]{70}\]",                          # 70-segment bar → ~87-char line
        rb"progress: 100% done",
    ],
    "wide_utf8": [
        "終端機歷史緩衝區測試".encode(),
        "🚀".encode(),
        b"e\xcc\x81",                            # combining acute
        "邊界換行測試".encode(),
    ],
    "long_wrap": [
        rb"W1-001\.",
        rb"W3-120\.",
    ],
    "alt_screen": [
        CSI + rb"\?1049h",                       # enter alt screen
        rb"INSIDE ALT SCREEN line 2",
        CSI + rb"\?1049l",                       # leave alt screen
        rb"after alt-screen",
    ],
    "scroll_region": [
        CSI + rb"2;8r",                          # DECSTBM set
        rb"scrolling region line 15",
        CSI + rb"r",                             # DECSTBM reset
    ],
    "clear_screen": [
        CSI + rb"2J",
        CSI + rb"3J",                            # scrollback clear
        rb"after 3J scrollback-clear",
    ],
    "osc": [
        re.escape(ESC + b"]0;fuzz-title-42\x07"),
        re.escape(ESC + b"]8;;https://example.com/fuzz\x07"),
        re.escape(ESC + b"]0;st-terminated-title" + ESC + b"\\"),
    ],
    "sgr_styles": [
        CSI + rb"1mbold",
        CSI + rb"3mitalic",
        CSI + rb"4munderline",
        CSI + rb"1;3;4;31mcombined",
        CSI + rb"1;44m",                         # style spanning soft wrap
    ],
    "tabs_controls": [
        rb"col1\tcol2",
        rb"abcX\x08Y",                           # backspace
        rb"\x07",                                # BEL
        rb"vertical\x0btab",                     # VT
    ],
    "burst": [
        rb"burst 0001",
        rb"burst 4500",
    ],
    "save_restore_cursor": [
        re.escape(ESC + b"7"),                   # DECSC
        re.escape(ESC + b"8"),                   # DECRC
        CSI + rb"s",
        CSI + rb"u",
        rb"done save-restore",
    ],
    "line_edits": [
        CSI + rb"2L",                            # IL
        CSI + rb"1M",                            # DL
        CSI + rb"3@",                            # ICH
        CSI + rb"2P",                            # DCH
        rb"line edits done",
    ],
    "incomplete_escape": [
        rb"truncation sentinel",
        CSI + rb"38;5;1\Z",                      # stream ENDS mid-escape
    ],
}

# Strategies whose byte volume matters (truncation / chunking pressure).
MIN_SIZES = {"burst": 200_000}

COLS, ROWS = 100, 30


def run_strategy_in_pty(name: str) -> bytes:
    """Run one strategy under a real PTY and capture the raw byte stream."""
    proc = PtyProcess.spawn(
        ["bash", str(STRATEGIES_SH), name],
        dimensions=(ROWS, COLS),
        env={**os.environ, "TERM": "xterm-256color"},
    )
    captured = bytearray()
    while True:
        try:
            captured.extend(proc.read(65536))
        except EOFError:
            break
    proc.wait()
    return bytes(captured)


def list_strategies() -> list[str]:
    import subprocess

    out = subprocess.run(
        ["bash", str(STRATEGIES_SH), "--list"], capture_output=True, text=True, check=True
    )
    return out.stdout.split()


def test_strategy_list_matches_expectations():
    """strategies.sh --list and EXPECTATIONS must never drift apart."""
    assert list_strategies() == list(EXPECTATIONS.keys())


def test_unknown_strategy_fails():
    import subprocess

    out = subprocess.run(
        ["bash", str(STRATEGIES_SH), "no_such_strategy"], capture_output=True, text=True
    )
    assert out.returncode != 0
    assert "unknown strategy" in out.stderr


@pytest.mark.parametrize("name", list(EXPECTATIONS.keys()))
def test_strategy_produces_expected_bytes(name: str):
    """Each generator must actually emit the escape patterns it claims."""
    captured = run_strategy_in_pty(name)
    assert captured, f"{name}: PTY produced no output"

    for pattern in EXPECTATIONS[name]:
        assert re.search(pattern, captured, re.DOTALL), (
            f"{name}: expected pattern {pattern!r} not found in {len(captured)}-byte stream; "
            f"tail={captured[-200:]!r}"
        )

    min_size = MIN_SIZES.get(name)
    if min_size:
        assert len(captured) >= min_size, (
            f"{name}: expected >= {min_size} bytes for chunking pressure, got {len(captured)}"
        )


def test_strategies_are_deterministic():
    """Same strategy twice → identical bytes (required by the diff oracle)."""
    for name in ("erase_repaint", "ansi_colors", "wide_utf8"):
        assert run_strategy_in_pty(name) == run_strategy_in_pty(name), (
            f"{name}: output differs between runs — matrix results would be unreproducible"
        )
