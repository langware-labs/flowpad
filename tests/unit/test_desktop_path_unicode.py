"""Non-ASCII / special-character path handling on the desktop compute provider.

Two incidents share this file, and its tests pin down both:

1. **"Other langs" fixes (Hebrew folders)** — non-ASCII text was being mangled
   by cp1252 defaults on Windows:
     * ``_ps_single_quote`` — the folder-picker embeds a path into a PowerShell
       script; it must stay a literal no matter what characters it carries.
     * dev file logging — must be UTF-8 so a non-ASCII traceback is recorded
       instead of being silently dropped by a cp1252 ``charmap`` error.

2. **The "Flowpad workspace" resume crash-loop (paths with spaces)** — that
   same incident also added a PTY-spawn workaround (``_winpty_safe_cwd``) that
   rewrote every long cwd to its 8.3 short name (``FLOWPA~1``). Session-keyed
   CLIs derive their transcript-store key from the exact cwd string, so
   ``claude --resume`` under the renamed cwd found no transcript and exited
   immediately. The workaround's premise ("winpty rejects non-ANSI cwds") does
   not hold for pywinpty ≥ 3 — both its ConPTY and winpty backends spawn into
   non-ASCII directories natively — so it was removed outright.

   The two real-PTY tests below (Windows-only, no mocks) pin both sides of
   that removal:
     * a spawned PTY runs in the EXACT cwd it was given — spaces included, no
       8.3 renaming anywhere (the crash-loop regression), and
     * a PTY spawns fine in a Hebrew-named directory with no rewriting (the
       scenario the removed workaround was supposedly needed for).
"""

import logging
import sys

import pytest

from flow_sdk.compute.providers.desktop.provider import _ps_single_quote

HEBREW_DIR = "C:\\Users\\שני\\פרויקט"  # C:\Users\שני\פרויקט
HEBREW_FOLDER_NAME = "שני פרויקט"


# ---------------------------------------------------------------------------
# _ps_single_quote — PowerShell literal escaping (pure, OS-independent)
# ---------------------------------------------------------------------------


def test_ps_single_quote_wraps_plain_path():
    assert _ps_single_quote("C:\\projects\\app") == "'C:\\projects\\app'"


def test_ps_single_quote_doubles_embedded_quote():
    # The one character with meaning inside a single-quoted PS string is "'".
    assert _ps_single_quote("O'Brien") == "'O''Brien'"


def test_ps_single_quote_preserves_hebrew_verbatim():
    quoted = _ps_single_quote(HEBREW_DIR)
    assert quoted == f"'{HEBREW_DIR}'"
    assert HEBREW_DIR in quoted  # characters untouched, not escaped/stripped


def test_ps_single_quote_neutralizes_injection():
    # A path crafted to break out and run a command must stay inert: every
    # quote is doubled, so it can't terminate the literal.
    payload = "x'; Remove-Item C:\\ -Recurse -Force #"
    quoted = _ps_single_quote(payload)
    assert quoted.startswith("'") and quoted.endswith("'")
    assert "''" in quoted  # the breakout quote was doubled
    # No single (odd) quote survives that could close the literal early.
    assert quoted[1:-1].count("'") % 2 == 0


# ---------------------------------------------------------------------------
# Real-PTY spawn cwd fidelity (Windows-only, no mocks)
# ---------------------------------------------------------------------------


def _spawn_pty_and_read_cwd(cwd: str) -> str:
    """Spawn ``cmd /c cd`` in a real PTY at *cwd* and return everything the
    child printed (its working directory, plus terminal escape sequences)."""
    from flow_sdk.compute.providers.desktop.provider import PtyProcess

    proc = PtyProcess.spawn("cmd /c cd", cwd=cwd)
    chunks: list[str] = []
    while proc.isalive():
        try:
            chunks.append(proc.read())
        except EOFError:
            break
    # Drain whatever the pipe still buffers after exit.
    try:
        while True:
            chunks.append(proc.read())
    except Exception:
        pass
    return "".join(chunks)


@pytest.mark.skipif(sys.platform != "win32", reason="real winpty spawn; run on a Windows host")
def test_pty_runs_in_exact_cwd_with_space(tmp_path):
    """The PTY child must run in the EXACT directory string it was given.

    Regression for the resume crash-loop: a since-removed workaround rewrote
    the spawn cwd to its 8.3 short name (``Flowpad workspace`` → ``FLOWPA~1``).
    The Claude CLI keys ``~/.claude/projects/<encoded-cwd>`` off the exact cwd
    string, so a session created under the long form and resumed under the
    short form found no transcript and exited within seconds. With the rewrite
    gone, the child's reported cwd is byte-for-byte the requested path.
    """
    workdir = tmp_path / "Flowpad workspace" / "teachpal-zone"
    workdir.mkdir(parents=True)
    requested = str(workdir)

    output = _spawn_pty_and_read_cwd(requested)

    assert requested in output, (
        f"PTY child ran in a rewritten cwd; requested {requested!r} "
        f"but child printed: {output!r}"
    )
    # And specifically: no 8.3 alias of the space-bearing folder crept back in.
    assert "FLOWPA~" not in output.upper().replace(requested.upper(), "")


@pytest.mark.skipif(sys.platform != "win32", reason="real winpty spawn; run on a Windows host")
def test_pty_spawns_in_hebrew_cwd_without_rewriting(tmp_path):
    """A PTY spawns fine in a Hebrew-named directory passed verbatim.

    This is the scenario the removed ``_winpty_safe_cwd`` workaround claimed
    to be needed for ("winpty rejects non-ANSI cwds with WinError 123").
    pywinpty ≥ 3 spawns non-ASCII cwds natively on both the ConPTY and winpty
    backends, so no renaming is needed — and the session-keyed cwd string
    stays stable for resume in Hebrew projects too.
    """
    workdir = tmp_path / HEBREW_FOLDER_NAME
    workdir.mkdir(parents=True)

    output = _spawn_pty_and_read_cwd(str(workdir))

    assert HEBREW_FOLDER_NAME in output, (
        f"PTY child did not report the Hebrew cwd; child printed: {output!r}"
    )


# ---------------------------------------------------------------------------
# Dev file logging is UTF-8 (so non-ASCII tracebacks aren't dropped)
# ---------------------------------------------------------------------------


@pytest.fixture
def dev_logging(tmp_path, monkeypatch):
    """Enable the dev file-logging mirror against a temp dir, cleaned up after."""
    from flow_sdk import service_log

    def _drop_dev_handlers():
        root = logging.getLogger()
        for h in [h for h in root.handlers if getattr(h, "_flowpad_dev_file", False)]:
            root.removeHandler(h)

    _drop_dev_handlers()
    monkeypatch.setattr(service_log, "is_development", True)
    monkeypatch.setattr(service_log, "_logs_base", lambda: tmp_path)
    logging.getLogger("flow_sdk.service_log").setLevel(logging.DEBUG)
    try:
        yield service_log
    finally:
        _drop_dev_handlers()
        service_log.log_to_folder = False
        service_log._log_file = None


def test_dev_file_handler_is_utf8(dev_logging):
    path = dev_logging.init_dev_file_logging()
    assert path is not None

    handler = next(h for h in logging.getLogger().handlers if getattr(h, "_flowpad_dev_file", False))
    assert (handler.encoding or "").lower() == "utf-8"


def test_dev_log_mirror_roundtrips_hebrew(dev_logging):
    path = dev_logging.init_dev_file_logging()
    assert path is not None

    dev_logging.info(HEBREW_DIR)
    for h in logging.getLogger().handlers:
        h.flush()

    content = path.read_text(encoding="utf-8")
    assert HEBREW_DIR in content
