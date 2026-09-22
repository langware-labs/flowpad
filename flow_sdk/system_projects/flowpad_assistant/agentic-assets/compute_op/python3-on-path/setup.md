Install Python 3 with the platform's own package manager so that `python3 --version` answers from a fresh shell.

The check is the RUNNABLE question, not the on-PATH one: a dangling symlink satisfies `command -v python3` and still cannot run.
