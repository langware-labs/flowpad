Install Git with the platform's own package manager so that `git --version` answers from a fresh shell.

On a slim image the package index ships empty, so an install fails with "unable to locate package" until it has been refreshed.

On Windows this op installs **MinGit** (`winget install Git.MinGit`), not "Git for Windows". The full installer is machine-wide and always opens a Windows permission prompt, even with `--scope user`; MinGit is a portable zip that unpacks into the user's profile and needs no administrator rights and no prompt. It is the same `git`, without Git Bash and without the GUI.

If you must install by hand, take the same route: the `MinGit-<version>-64-bit.zip` (or `-arm64.zip`) from https://github.com/git-for-windows/git/releases, unpacked under `%LOCALAPPDATA%\Programs` with its `cmd` folder added to the USER PATH. Do not run the Git for Windows installer: it asks for administrator rights.

Claude Code treats Git Bash as optional on Windows — without it, it runs shell commands through PowerShell. If Git Bash is wanted, `CLAUDE_CODE_GIT_BASH_PATH` can point at any `bash.exe`.
