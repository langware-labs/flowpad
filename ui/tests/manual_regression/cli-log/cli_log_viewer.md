---
id: 3d5e7a90-4b6c-4d82-a1f3-5e7c9b0d2f41
---

# Corrected 2026-05-31: there is NO `flow log show` subcommand. The viewer is the
# bare `flow log` command (with --limit / --level); subcommands are replay,
# settings, clear. The on-disk log lives at
# ~/.flow/instances/oss/logs/cli.log.jsonl (NOT ~/.flow/logs/cli.log.jsonl).

test 1: `flow log` lists recent CLI log entries
- [bash] run "flow log --limit 20"
- validate the command exits 0

test 2: `flow log --help` exposes the real subcommands (replay/settings/clear)
- [bash] run "flow log --help"
- validate the command exits 0
- validate the help text mentions "clear" (the documented clear subcommand)

test 3: `flow log clear` empties the log
- [bash] run "flow log clear"
- validate the command exits 0
- [bash] run "flow log --limit 5"
- validate the command exits 0
