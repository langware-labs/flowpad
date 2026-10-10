"""The one classifier the monitor, the CLI and the desktop app share (FLOWPAD-2231).

Narrow by design: the exact application-control ImportError, a refused or
wrong-architecture interpreter, and a missing CRITICAL native module are fatal;
an optional module, a non-zero exit, a transient crash, and an audit-only Code
Integrity event are not.
"""

from __future__ import annotations

import json

import pytest

from flow_sdk.server import failure_classification as fc

FIELD_TRACEBACK = """\
2026-10-10 13:27:03,100 INFO starting
Traceback (most recent call last):
  File "<frozen runpy>", line 198, in _run_module_as_main
  File "C:\\Users\\nava\\AppData\\Roaming\\uv\\tools\\flowpad\\Lib\\site-packages\\flow_sdk\\server\\run.py", line 12, in <module>
    import uvicorn
  File "C:\\Users\\nava\\AppData\\Roaming\\uv\\tools\\flowpad\\Lib\\site-packages\\uvicorn\\__init__.py", line 1, in <module>
    from uvicorn.config import Config
  File "C:\\Users\\nava\\AppData\\Roaming\\uv\\python\\cpython-3.11.17-windows-x86_64-none\\Lib\\multiprocessing\\connection.py", line 22, in <module>
    import _multiprocessing
ImportError: DLL load failed while importing _multiprocessing: An Application Control policy has blocked this file.
"""


# ---------------------------------------------------------------------------
# Fatal shapes
# ---------------------------------------------------------------------------


def test_the_field_import_error_is_a_fatal_policy_block():
    v = fc.classify_server_log(FIELD_TRACEBACK, exit_code=1)
    assert v.fatal and v.kind == fc.POLICY_BLOCKED
    assert v.module == "_multiprocessing"
    assert v.excerpt.startswith("ImportError: DLL load failed while importing _multiprocessing")
    assert v.traceback.startswith("Traceback (most recent call last)")
    assert v.evidence["file"].endswith("connection.py")
    assert v.evidence["enforced"] is True
    assert v.repairable
    assert v.exit_code == 1


@pytest.mark.parametrize(
    "os_text",
    [
        "An Application Control policy has blocked this file.",
        "[WinError 4551] An Application Control policy has blocked this file",
        "Your organization used Device Guard to block this app.",
        "This program is blocked by group policy. For more information, contact your system administrator.",
        "os error 4551",
    ],
)
def test_every_policy_wording_counts(os_text):
    v = fc.classify_server_log(f"ImportError: DLL load failed while importing _ssl: {os_text}")
    assert v.fatal and v.kind == fc.POLICY_BLOCKED and v.module == "_ssl"


def test_the_last_recognised_line_wins_over_an_earlier_transient_one():
    text = "ConnectionResetError: transient\n" + FIELD_TRACEBACK
    assert fc.classify_server_log(text).kind == fc.POLICY_BLOCKED
    text2 = (
        FIELD_TRACEBACK
        + "\nINFO restarted fine\nImportError: DLL load failed while importing _ssl: The specified module could not be found."
    )
    assert fc.classify_server_log(text2).kind == fc.NATIVE_MISSING


def test_a_missing_critical_native_module_is_fatal():
    v = fc.classify_server_log(
        "ImportError: DLL load failed while importing _sqlite3: The specified module could not be found."
    )
    assert v.fatal and v.kind == fc.NATIVE_MISSING and v.module == "_sqlite3"


def test_a_wrong_architecture_critical_module_is_fatal():
    v = fc.classify_server_log(
        "ImportError: DLL load failed while importing _ctypes: %1 is not a valid Win32 application."
    )
    assert v.fatal and v.kind == fc.UNSUPPORTED_ARCH


# ---------------------------------------------------------------------------
# NOT fatal: the narrowness is the point
# ---------------------------------------------------------------------------


def test_an_optional_modules_dll_failure_is_not_fatal():
    v = fc.classify_server_log(
        "ImportError: DLL load failed while importing _some_plugin_accel: The specified module could not be found."
    )
    assert not v.fatal and v.kind == fc.UNKNOWN


def test_a_plain_import_error_is_not_fatal():
    v = fc.classify_server_log("ImportError: No module named 'optional_extra'", exit_code=1)
    assert not v.fatal


def test_a_nonzero_exit_with_no_recognised_cause_is_not_fatal():
    v = fc.classify_server_log("2026-10-10 INFO shutting down\nKilled", exit_code=137)
    assert not v.fatal and v.exit_code == 137


def test_an_empty_or_missing_log_is_not_fatal():
    assert not fc.classify_server_log("").fatal
    assert not fc.classify_server_log(None).fatal


def test_policy_text_outside_an_import_error_is_recorded_but_not_fatal():
    # A worker the server spawned was refused: the server reports it and keeps running.
    v = fc.classify_server_log(
        "WARNING worker spawn failed: [WinError 4551] An Application Control policy has blocked this file"
    )
    assert not v.fatal and v.excerpt and v.evidence.get("enforced") is True


# ---------------------------------------------------------------------------
# Spawn failures: the interpreter itself
# ---------------------------------------------------------------------------


def test_a_policy_refused_interpreter_is_fatal():
    exc = OSError(22, "An Application Control policy has blocked this file")
    exc.winerror = 4551
    v = fc.classify_spawn_error(exc)
    assert v.fatal and v.kind == fc.INTERPRETER_BLOCKED and v.source == "spawn"


def test_a_wrong_architecture_interpreter_is_fatal():
    exc = OSError(8, "%1 is not a valid Win32 application")
    exc.winerror = 193
    assert fc.classify_spawn_error(exc).kind == fc.UNSUPPORTED_ARCH


def test_a_missing_interpreter_is_fatal():
    assert fc.classify_spawn_error(FileNotFoundError(2, "No such file")).kind == fc.NATIVE_MISSING


def test_an_unknown_spawn_error_is_not_fatal():
    assert not fc.classify_spawn_error(OSError(11, "Resource temporarily unavailable")).fatal


# ---------------------------------------------------------------------------
# Code Integrity events: enforced vs audit
# ---------------------------------------------------------------------------


def test_only_3077_is_an_enforced_block():
    events = [
        {"id": 3076, "file": "_multiprocessing.pyd", "process": "python.exe"},  # audit "would block"
        {"id": 3033, "file": "x.dll"},
        {"id": 3077, "file": "_multiprocessing.pyd", "process": "python.exe"},
        {"id": "3089"},  # signature info, neither
        {"id": "garbage"},
    ]
    summary = fc.classify_code_integrity_events(events)
    assert summary["enforced_block"] is True
    assert [e["id"] for e in summary["enforced"]] == [3077]
    assert [e["id"] for e in summary["audit"]] == [3076, 3033]


def test_audit_only_events_are_not_a_block():
    summary = fc.classify_code_integrity_events([{"id": 3076}, {"id": 3033}])
    assert summary["enforced_block"] is False
    assert fc.is_enforced_block_event(3077) and not fc.is_enforced_block_event(3076)


# ---------------------------------------------------------------------------
# Repetition and fingerprint
# ---------------------------------------------------------------------------


def test_crash_loop_verdict_is_fatal_and_carries_the_last_excerpt():
    last = fc.transient(exit_code=1)
    v = fc.crash_loop_verdict(fc.CRASH_LOOP_LIMIT, last)
    assert (
        v.fatal and v.kind == fc.CRASH_LOOP and v.source == "repetition" and v.evidence["deaths"] == fc.CRASH_LOOP_LIMIT
    )
    assert not v.repairable


def test_fingerprint_changes_with_interpreter_and_engine_only():
    a = fc.runtime_fingerprint(python="C:/a/python.exe", engine_version="0.2.203")
    same = fc.runtime_fingerprint(python="C:/a/python.exe", engine_version="0.2.203")
    other_py = fc.runtime_fingerprint(python="C:/repaired/python.exe", engine_version="0.2.203")
    other_engine = fc.runtime_fingerprint(python="C:/a/python.exe", engine_version="0.2.204")
    assert fc.same_fingerprint(a, same)
    assert not fc.same_fingerprint(a, other_py)
    assert not fc.same_fingerprint(a, other_engine)
    assert not fc.same_fingerprint(a, None)
    assert set(a) == {"hash", "python", "engine_version", "platform"}


def test_the_record_is_json_and_carries_what_the_desktop_app_reads(tmp_path):
    v = fc.classify_server_log(FIELD_TRACEBACK, exit_code=1)
    record = v.to_record(
        fingerprint=fc.runtime_fingerprint(python="C:/a/python.exe", engine_version="0.2.203"),
        at="2026-10-10T10:27:03+00:00",
        attempts=3,
        server_log="C:/logs/server/x.log",
        monitor_pid=42,
        engine_version="0.2.203",
    )
    text = json.dumps(record)  # must serialise
    back = json.loads(text)
    for key in (
        "schema",
        "kind",
        "fatal",
        "repairable",
        "reason",
        "module",
        "excerpt",
        "traceback",
        "source",
        "exit_code",
        "attempts",
        "restarts_stopped",
        "fingerprint",
        "server_log",
        "at",
        "monitor_pid",
    ):
        assert key in back, key
    assert back["schema"] == fc.SCHEMA_VERSION and back["kind"] == "policy-blocked" and back["restarts_stopped"] is True
    assert back["fingerprint"]["python"] == "C:/a/python.exe"
    # The fixture the Electron side is tested against (test 15, electron/fatal-failure.test.js) is this shape.
    (tmp_path / "server-failure.json").write_text(text)


def test_the_committed_electron_fixture_is_what_this_classifier_produces():
    """Test 15 (monitor side): electron/fixtures/server-failure.sample.json is the classifier's own output
    for the field traceback. If to_record() changes shape, regenerate the fixture and the JS test together."""
    from pathlib import Path

    fixture = json.loads(
        (Path(__file__).resolve().parents[2] / "electron" / "fixtures" / "server-failure.sample.json").read_text()
    )
    v = fc.classify_server_log(FIELD_TRACEBACK, exit_code=1)
    produced = v.to_record(
        fingerprint=fixture["fingerprint"],
        at=fixture["at"],
        attempts=fixture["attempts"],
        server_log=fixture["server_log"],
        monitor_pid=fixture["monitor_pid"],
        engine_version=fixture["engine_version"],
    )
    assert produced == fixture


def test_a_policy_block_on_a_wheel_module_is_fatal_but_not_repairable():
    """2026-10-10, Smart App Control ON: a two-day-old pydantic-core release's _pydantic_core.pyd had no
    reputation yet and was blocked. Deterministic (fatal), but a new interpreter does not change that file."""
    v = fc.classify_server_log(
        "ImportError: DLL load failed while importing _pydantic_core: An Application Control policy has blocked this file."
    )
    assert v.fatal and v.kind == fc.POLICY_BLOCKED and v.module == "_pydantic_core"
    assert v.repairable is False
    assert fc.classify_server_log(FIELD_TRACEBACK).repairable is True, "_multiprocessing ships with the interpreter"
    assert fc.is_interpreter_module("_ssl") and fc.is_interpreter_module("cryptography.hazmat.bindings._rust") is False


def test_rich_wrapped_launcher_output_is_recognised():
    """`flow start` prints through Rich, which wrapped the field line at 80 columns (2026-10-10)."""
    wrapped = (
        "│ core\\__init__.py:8 in <module>                                              │\n"
        "└─────────────────────────────────────────────────────────────────────────────┘\n"
        "ImportError: DLL load failed while importing _pydantic_core: An Application \n"
        "Control policy has blocked this file.\n"
    )
    v = fc.classify_server_log(wrapped, exit_code=1)
    assert v.fatal and v.kind == fc.POLICY_BLOCKED and v.module == "_pydantic_core" and not v.repairable
