Install Python 3 with the platform's own package manager.

The check accepts the name each OS actually installs: `python3` or `python` on Unix, the `py` launcher or `python.exe` on Windows. It never asks Windows for `python3` — that name is the Microsoft Store alias stub, which fails even when Python is installed. The version is matched, so a Python 2 on `python` does not pass.

On Windows, when the python.org installer fails for any reason (a 1603/1618/1322 from Windows Installer, a half-removed earlier install, no permission), install it with uv instead: `uv python install 3.12 --default`. Flowpad installs uv, usually at `%USERPROFILE%\.local\bin\uv.exe`. It uses no Windows Installer, needs no permission prompt, and puts `python.exe` in `%USERPROFILE%\.local\bin`, which is on the user PATH the check reads — so the check passes. Do not count Flowpad's own interpreter (`…\uv\tools\flowpad\…`): the check does not see it.
