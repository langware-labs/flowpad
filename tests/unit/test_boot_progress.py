"""flow_sdk.boot_progress: a line per step forward, nothing while standing still.

The startup watchdogs read growth of this output as "the boot advanced", so the
contract under test is exactly that: growth if and only if the module count or
the phase changed, every line timestamped and flushed, and a stream that breaks
never breaking the boot.
"""

import io
import re
import sys
import threading

import pytest

from flow_sdk import boot_progress
from flow_sdk.boot_progress import ENV_BOOT_PROGRESS, BootProgress

LINE = re.compile(
    r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[boot\] t=(?P<t>\d+\.\d)s "
    r"phase=(?P<phase>\S+) modules=(?P<modules>\d+) last=(?P<last>\S+)$"
)


class FlushCountingStream(io.StringIO):
    def __init__(self):
        super().__init__()
        self.flushes = 0

    def flush(self):
        self.flushes += 1
        super().flush()


def _reporter(modules: dict, clock: list[float]):
    stream = FlushCountingStream()
    reporter = BootProgress(stream, modules=modules, monotonic=lambda: clock[0])
    return reporter, stream


def _lines(stream: io.StringIO) -> list[re.Match]:
    out = []
    for raw in stream.getvalue().splitlines():
        m = LINE.match(raw)
        assert m, f"malformed boot line: {raw!r}"
        out.append(m)
    return out


@pytest.fixture(autouse=True)
def no_process_reporter(monkeypatch):
    """The module-level reporter is per process; a test never inherits one."""
    monkeypatch.setattr(boot_progress, "_current", None)
    monkeypatch.delenv(ENV_BOOT_PROGRESS, raising=False)


def test_a_line_when_the_module_count_grows_and_none_when_it_does_not():
    modules = {"a": 1}
    clock = [0.0]
    reporter, stream = _reporter(modules, clock)

    assert reporter.tick(force=True) is not None  # the first look always reports
    clock[0] = 1.0
    assert reporter.tick() is None, "nothing changed → no line"

    modules["b"] = 2
    clock[0] = 2.0
    line = reporter.tick()
    assert line is not None
    assert reporter.tick() is None, "the same count twice is not progress"

    first, second = _lines(stream)
    assert (first["modules"], first["last"], first["t"]) == ("1", "a", "0.0")
    assert (second["modules"], second["last"], second["t"]) == ("2", "b", "2.0")


def test_a_phase_change_reports_at_once_without_any_import():
    modules = {"a": 1}
    reporter, stream = _reporter(modules, [0.0])
    reporter.tick(force=True)

    reporter.set_phase("migration")

    assert [m["phase"] for m in _lines(stream)] == ["import", "migration"]
    assert reporter.tick() is None, "the phase was already reported"


def test_stop_writes_the_done_line_once_and_ends_reporting():
    modules = {"a": 1}
    reporter, stream = _reporter(modules, [0.0])
    reporter.tick(force=True)

    reporter.stop()
    reporter.stop()
    modules["b"] = 2
    reporter.set_phase("late")

    assert [m["phase"] for m in _lines(stream)] == ["import", "done"]


def test_every_line_is_flushed_as_it_is_written():
    reporter, stream = _reporter({"a": 1}, [0.0])
    reporter.tick(force=True)
    reporter.set_phase("db")
    assert stream.flushes == 2


def test_a_broken_stream_never_breaks_the_boot():
    class Broken(io.StringIO):
        def write(self, _s):
            raise OSError("closed")

    reporter = BootProgress(Broken(), modules={"a": 1})
    assert reporter.tick(force=True) is None
    reporter.set_phase("db")
    reporter.stop()


def test_the_thread_reports_real_import_growth_and_stops_cleanly():
    """The scheduled path, on real sys.modules: importing a module the process
    has not seen yet grows the count, and the thread reports it."""
    stream = io.StringIO()
    reporter = BootProgress(stream, interval=0.01)
    reporter.start()
    before = len(sys.modules)
    import colorsys  # noqa: F401 — stdlib, unlikely to be loaded already

    seen = threading.Event()
    for _ in range(200):
        if any(int(m["modules"]) > before for m in _lines(stream)):
            seen.set()
            break
        threading.Event().wait(0.01)
    reporter.stop()
    assert seen.is_set() or len(sys.modules) == before, "growth went unreported"
    assert _lines(stream)[-1]["phase"] == "done"


def test_the_process_reporter_starts_only_when_the_launcher_asked(monkeypatch):
    stream = io.StringIO()
    assert boot_progress.start_if_requested(stream) is None
    boot_progress.set_phase("ignored")  # a no-op without a reporter
    assert stream.getvalue() == ""

    monkeypatch.setenv(ENV_BOOT_PROGRESS, "1")
    reporter = boot_progress.start_if_requested(stream)
    try:
        assert reporter is not None
        assert ENV_BOOT_PROGRESS not in boot_progress.os.environ, "consumed, not inherited by children"
        boot_progress.set_phase("migration")
        assert [m["phase"] for m in _lines(stream)] == ["import", "migration"]
    finally:
        boot_progress.stop()
    assert _lines(stream)[-1]["phase"] == "done"
    assert boot_progress._current is None
