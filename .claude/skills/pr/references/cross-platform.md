# Windows & Unix compatibility

Flowpad runs on Windows, macOS and Linux. Check the diff's added lines for these three things.

## 1. Paths

- Build paths with `pathlib.Path` (`/`, `.parent`, `.name`), not string `+ "/"`, `split("/")` or `os.sep` math.
- Windows paths have a drive letter (`C:\…`), use `\`, and are case-insensitive. A check like
  `startswith("/")` (meaning "is absolute"), `p[0] == "/"`, or splitting on `/` breaks on them.
- Compare or store paths through the existing helpers in `flow_sdk/fs_store/path_utils.py`:
  `canonical_posix_path()` (resolve, then `as_posix()`, then NFC) and `is_path_under()` (containment
  that respects segment boundaries). We have shipped several bugs from hand-rolled `\` vs `/` and
  drive-letter handling.

## 2. OS-only APIs

- Unix only: `fcntl`, `termios`, `pty`, `os.fork`, `os.killpg`, `os.setsid`, `signal.SIGKILL`/`SIGHUP`,
  `os.getuid`, `/tmp`, `/dev/null`.
- Windows only: `msvcrt`, `winreg`, `ctypes.windll`.
- Any of these must sit behind a `sys.platform == "win32"` branch or have a cross-platform
  replacement (`psutil`, `tempfile`, `os.devnull`). Example: `deployment_process._try_lock` uses
  `msvcrt` on Windows and `fcntl` elsewhere.

## 3. Lines typed into a shell

A terminal runs `default_terminal_shell()`: on Windows that is **PowerShell** (`cmd.exe` if no PowerShell
is found); elsewhere it is the user's `$SHELL`, or zsh on macOS and bash/sh on Linux when `$SHELL` is
unset. `shlex.quote` quotes for POSIX shells only. In PowerShell, a line that starts with a quoted path is read as a string, not a
command, so it fails with `Unexpected token` (FLOWPAD-2255). On Windows, use `& '<exe>' '<arg>'`, with
each `'` inside a value doubled. Reuse `flow_sdk/core/flow_command.py:flow_command` or
`snippet.WIN32_RUNNERS`; for shell-specific syntax, see `Shell.sentinel_command`. Passing an argv list
to `subprocess` needs no shell quoting at all.

Severity: **major** when the code path runs on a platform it breaks on; **minor** otherwise.
