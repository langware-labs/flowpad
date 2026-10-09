Install Python 3 with the platform's own package manager.

The check accepts the name each OS actually installs: `python3` or `python` on Unix, the `py` launcher or `python.exe` on Windows. It never asks Windows for `python3` — that name is the Microsoft Store alias stub, which fails even when Python is installed. The version is matched, so a Python 2 on `python` does not pass.

On Windows, when the python.org installer fails for any reason (a 1603/1618/1322 from Windows Installer, a half-removed earlier install, no permission), install it with uv instead: `uv python install 3.12 --default`. Flowpad installs uv, usually at `%USERPROFILE%\.local\bin\uv.exe`. It uses no Windows Installer, needs no permission prompt, and puts `python.exe` in `%USERPROFILE%\.local\bin`, which is on the user PATH the check reads — so the check passes. Do not count Flowpad's own interpreter (`…\uv\tools\flowpad\…`): the check does not see it.

On macOS `/usr/bin/python3` is the same kind of stub as `/usr/bin/git`: until Apple's Command Line Tools are installed, running `python3 --version` opens a system "install the developer tools" dialog instead of answering. So the check never runs the `/usr/bin` one unless the tools are there (`xcode-select -p` names a directory that holds `python3`); a Python found anywhere else (Homebrew, python.org, uv) is run as usual.
