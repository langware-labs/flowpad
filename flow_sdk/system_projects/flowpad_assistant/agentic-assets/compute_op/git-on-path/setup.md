Install Git with the platform's own package manager so that `git --version` answers from a fresh shell.

On a slim image the package index ships empty, so an install fails with "unable to locate package" until it has been refreshed.

On Windows this op installs **MinGit** (`winget install Git.MinGit`), not "Git for Windows". The full installer is machine-wide and always opens a Windows permission prompt, even with `--scope user`; MinGit is a portable zip that unpacks into the user's profile and needs no administrator rights and no prompt. It is the same `git`, without Git Bash and without the GUI.

If you must install by hand, take the same route: the `MinGit-<version>-64-bit.zip` (or `-arm64.zip`) from https://github.com/git-for-windows/git/releases, unpacked under `%LOCALAPPDATA%\Programs` with its `cmd` folder added to the USER PATH. Do not run the Git for Windows installer: it asks for administrator rights.

Claude Code treats Git Bash as optional on Windows — without it, it runs shell commands through PowerShell. If Git Bash is wanted, `CLAUDE_CODE_GIT_BASH_PATH` can point at any `bash.exe`.

On macOS `git` is a stub until Apple's Command Line Tools are installed: running it (`git --version`) opens a system "install the developer tools" dialog instead of answering. So the check here never runs `git` — it asks `xcode-select -p` for the active developer directory and looks for `git` inside it (a `git` that is not the `/usr/bin/git` stub, such as Homebrew's, also counts). The install is `xcode-select --install`: it opens Apple's own installer (licence, password, download of a few hundred MB) and the command waits until the tools are in place.

Apple's installer window can open behind the app the person is looking at, and nobody can answer a window they cannot see. So right after `xcode-select --install` starts the install, the command activates the installer app (bundle `com.apple.dt.CommandLineTools.installondemand`) with `open -b`. `open` is deliberate: raising it with AppleScript (`activate`, or System Events) sends an Apple event to another app and makes macOS ask the person for Automation permission, a second prompt on top of the one we are trying to get answered. Done once, not repeatedly: after that the window is theirs. (`open` on the app's path fails on a Mac that has the tools, with "Launch failed": the app is started by macOS on demand, so the command asks LaunchServices for the already-running instance by bundle id instead.)

The command does not wait forever for an installer nobody is answering:

- if `xcode-select --install` cannot start (offline, Software Update unreachable) it exits with an error at once;
- once the installer app has been gone for 30 seconds (six checks, five seconds apart) and git is still missing, it exits with an error. That is a cancelled install, or one that failed in Apple's window. The check asks LaunchServices (`lsappinfo`, no process search that could match its own command line, no Apple event);
- while the installer app is open it keeps waiting, up to this op's `timeout_seconds`.

If the installer app closes while macOS is still installing in the background, the op reports an error, and the message says to run the setup again when it finishes; the check then passes.
