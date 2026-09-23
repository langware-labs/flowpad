---
id: c14b4693-9c4d-442b-a218-e5edf4449582
---
Install cowsay so that `command -v cowsay` answers.

`pip install --user` exits 0 and puts the script in `~/.local/bin`, which is not
on the PATH of a non-login shell — so the install succeeds and the goal is still
not reached. Getting it on the PATH is the actual job.

The check runs in a FRESH shell each time, so exporting PATH inside your own
session changes nothing it will see. Put the executable somewhere already on the
PATH instead — a symlink into `/usr/local/bin` is enough.
