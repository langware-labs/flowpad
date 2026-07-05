"""Unicode/non-ASCII path handling on the desktop compute provider + logging.

Regression coverage for the Windows "Hebrew folder" failures:

  * ``_winpty_safe_cwd`` — winpty rejects non-ASCII cwd paths with
    ``[WinError 123]``; we hand it the ASCII 8.3 short name instead.
  * ``_ps_single_quote`` — the folder-picker embeds a path into a PowerShell
    script; it must stay a literal no matter what characters it carries.
  * dev file logging — must be UTF-8 so a non-ASCII traceback is recorded
    instead of being silently dropped by a cp1252 ``charmap`` error.

These all run (and pass) on every OS: the Windows-only branch of
``_winpty_safe_cwd`` is exercised by faking the platform constant + the
``GetShortPathNameW`` syscall, so no real Windows host is required.
"""

import ctypes
import logging
import sys

import pytest

from flow_sdk.compute.providers.desktop import provider
from flow_sdk.compute.providers.desktop.provider import (
    _ps_single_quote,
    _winpty_safe_cwd,
)

HEBREW_DIR = "C:\\Users\\שני\\פרויקט"  # C:\Users\שני\פרויקט


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
# _winpty_safe_cwd — ASCII short-path resolution on Windows
# ---------------------------------------------------------------------------


def test_winpty_safe_cwd_passthrough_for_unresolvable_path():
    """A path that has no short name resolves to itself on every OS.

    Off Windows the function returns immediately; on Windows
    ``GetShortPathNameW`` of a non-existent path returns 0 and we fall back to
    the input. Either way: unchanged.
    """
    missing = "C:\\this\\path\\does\\not\\exist\\__nope__"
    assert _winpty_safe_cwd(missing) == missing


def _force_windows(monkeypatch):
    """Make ``_winpty_safe_cwd`` take its Windows branch on any host without
    touching the real ``sys.platform`` (which other code reads)."""
    monkeypatch.setattr(provider, "PLATFORM_WIN32", sys.platform)


class _FakeProc:
    """Stand-in for a ctypes foreign function: callable, and tolerant of the
    ``.argtypes`` / ``.restype`` assignments the production code makes."""

    argtypes = None
    restype = None

    def __init__(self, fn):
        self._fn = fn

    def __call__(self, *args):
        return self._fn(*args)


def _fake_windll(impl):
    kernel32 = type("K", (), {"GetShortPathNameW": _FakeProc(impl)})()
    return type("W", (), {"kernel32": kernel32})()


def test_winpty_safe_cwd_uses_short_name_on_windows(monkeypatch):
    short = "C:\\Users\\SHANI~1\\PROYEK~1"  # ASCII 8.3 form of the Hebrew dir

    def get_short(path, buf, size):
        if buf is None:
            return len(short) + 1  # required buffer size incl. NUL
        buf.value = short
        return len(short)

    _force_windows(monkeypatch)
    monkeypatch.setattr(ctypes, "windll", _fake_windll(get_short), raising=False)

    assert _winpty_safe_cwd(HEBREW_DIR) == short


def test_winpty_safe_cwd_falls_back_when_api_raises(monkeypatch):
    def boom(path, buf, size):
        raise OSError("simulated GetShortPathNameW failure")

    _force_windows(monkeypatch)
    monkeypatch.setattr(ctypes, "windll", _fake_windll(boom), raising=False)

    # Never propagate — the spawn must still get a usable path.
    assert _winpty_safe_cwd(HEBREW_DIR) == HEBREW_DIR


@pytest.mark.skipif(sys.platform != "win32", reason="real GetShortPathNameW; run on a Windows host")
def test_winpty_safe_cwd_keeps_ansi_path_with_space(tmp_path):
    """A plain-ASCII cwd whose folder name merely contains a space must keep
    its long form.

    ``GetShortPathNameW`` shortens EVERY long component, not only the
    non-ANSI-representable ones the Hebrew workaround was added for. When the
    PTY resume path spawns ``claude --resume`` against the 8.3 alias
    (``FLOWPA~1``), the CLI derives its ``~/.claude/projects/<encoded-cwd>``
    slug from that alias, finds no transcript for a session created under the
    long form (the headless spawn path), and exits within seconds — the
    "Flowpad workspace" resume crash-loop.

    No mocks: real directory, real syscall, real ``_winpty_safe_cwd``.
    """
    workdir = tmp_path / "Flowpad workspace" / "teachpal-zone"
    workdir.mkdir(parents=True)
    long_form = str(workdir)

    # Precondition: the volume actually generates 8.3 aliases. If generation
    # is disabled, GetShortPathNameW echoes the input and this test could not
    # tell the fix from the bug — skip rather than pass vacuously.
    import ctypes as real_ctypes
    from ctypes import wintypes

    fn = real_ctypes.windll.kernel32.GetShortPathNameW
    fn.argtypes = [wintypes.LPCWSTR, wintypes.LPWSTR, wintypes.DWORD]
    fn.restype = wintypes.DWORD
    needed = fn(long_form, None, 0)
    buf = real_ctypes.create_unicode_buffer(needed or 1)
    fn(long_form, buf, needed or 1)
    if not needed or buf.value == long_form:
        pytest.skip("8.3 short-name generation disabled on this volume")

    assert _winpty_safe_cwd(long_form) == long_form


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
