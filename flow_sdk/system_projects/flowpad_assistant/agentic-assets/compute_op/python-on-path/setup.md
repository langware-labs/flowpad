Install Python 3 with the platform's own package manager.

The check accepts the name each OS actually installs: `python3` or `python` on Unix, the `py` launcher or `python.exe` on Windows. It never asks Windows for `python3` — that name is the Microsoft Store alias stub, which fails even when Python is installed. The version is matched, so a Python 2 on `python` does not pass.
