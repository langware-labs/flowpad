---
id: 3bd944d4-d5aa-4a6b-bdfa-1646d6af7152
---
This is a fresh Debian container: no Java, and no init system — there is no systemd, so nothing will restart the broker or keep it alive for you. The broker must keep running after your shell command returns and after you stop.

The goal is a working broker, proven end to end: a message produced to a new topic can be consumed back. Installed-but-not-running, or running-only-while-you-watch, is not reached.
