"""Is this PID still running? — one correct answer, stdlib only.

``os.kill(pid, 0)`` is the POSIX idiom for "does this process exist", and it is
**actively destructive on Windows**. CPython's Windows ``os.kill`` branches on
the signal number, and ``signal.CTRL_C_EVENT == 0`` — so signal 0, the probe
that means "check, don't touch" everywhere else, is routed to
``GenerateConsoleCtrlEvent(CTRL_C_EVENT, pid)``. It does not report liveness;
it delivers a console Ctrl-C to every process in that group sharing the
console, the caller included. A backend that "checked" whether its own recorded
PID was alive Ctrl-C'd itself: uvicorn caught the signal and shut down seconds
after startup, and the KeyboardInterrupt landing inside the ``os.kill`` call
surfaced as the giveaway ``SystemError: <built-in function kill> returned a
result with an exception set``.

This module is stdlib-only and never raises, so it stays usable from the
hook-broadcast path and from ``server/run.py`` before the app is importable —
the two places that reached for ``os.kill`` precisely because psutil was too
expensive to import there.
"""

import os
import sys

if sys.platform == "win32":
    import ctypes
    from ctypes import wintypes

    _SYNCHRONIZE = 0x00100000
    _PROCESS_QUERY_LIMITED_INFORMATION = 0x00001000
    _WAIT_OBJECT_0 = 0x00000000
    _ERROR_ACCESS_DENIED = 5

    _kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    _kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    _kernel32.OpenProcess.restype = wintypes.HANDLE
    _kernel32.WaitForSingleObject.argtypes = (wintypes.HANDLE, wintypes.DWORD)
    _kernel32.WaitForSingleObject.restype = wintypes.DWORD
    _kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    _kernel32.CloseHandle.restype = wintypes.BOOL

    def _win_pid_is_alive(pid: int) -> bool:
        handle = _kernel32.OpenProcess(_SYNCHRONIZE | _PROCESS_QUERY_LIMITED_INFORMATION, False, pid)
        if not handle:
            # Can't open it: ACCESS_DENIED means it exists but belongs to
            # someone else (alive); anything else — chiefly INVALID_PARAMETER
            # for an unused PID — means there is nothing there.
            return ctypes.get_last_error() == _ERROR_ACCESS_DENIED
        try:
            # Waiting zero on a process handle is the exact liveness question:
            # signalled means it has exited, timeout means it is still running.
            # Preferred over GetExitCodeProcess, which cannot distinguish a live
            # process from one that exited with code 259 (STILL_ACTIVE).
            return _kernel32.WaitForSingleObject(handle, 0) != _WAIT_OBJECT_0
        finally:
            _kernel32.CloseHandle(handle)


def pid_is_alive(pid: int | None) -> bool:
    """Return True if *pid* names a running process. Never raises.

    PID reuse is not defended against here — a caller that must distinguish a
    recycled PID from the one it recorded should verify identity too (see
    ``flow_sdk.server.launch.is_process_alive``, which compares the cmdline).
    """
    if not pid or pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            return _win_pid_is_alive(pid)
        os.kill(pid, 0)  # POSIX only — see module docstring
    except PermissionError:
        return True  # exists, owned by another user
    except (OSError, ValueError):
        return False
    return True
