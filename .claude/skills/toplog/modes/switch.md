---
id: 1014738b-fe24-4b54-bcc9-84b4d58aeb9e
---
# Mode: `on | off | status` — flip tags directly

Use this when the user just wants a tag switched ("toplog pty on", "stop pty
logging", "turn off all tracing", "what's on?") without a full `run`. One REST
call per action. The backend writes `toplog.json` and broadcasts it, so the
backend and every open tab follow immediately, with no reload.

1. **Resolve the instance and its port** exactly as `run.md` step 3 does. For
   `on`, also confirm that instance runs code containing the tag's log points.
   An old process logs nothing, and that silence looks like "nothing happened".
2. **Act**, with `P=<backend port>`:

   | Ask | Call |
   | --- | --- |
   | `on <tags>` | `curl -s -XPOST localhost:$P/api/v1/toplog/enable` then `curl -s -XPOST localhost:$P/api/v1/toplog/on -H 'content-type: application/json' -d '{"tags":["<tag>"]}'` |
   | `off <tags>` | `curl -s -XPOST localhost:$P/api/v1/toplog/off -H 'content-type: application/json' -d '{"tags":["<tag>"]}'` |
   | `off` (everything) | `curl -s -XPOST localhost:$P/api/v1/toplog/disable`. This also clears persist if it was set: `.../persist -d '{"persist":false}'` |
   | `status` | `curl -s localhost:$P/api/v1/toplog/state` → `{enabled, filter, persist}` |
   | keep across restart (only when asked) | `curl -s -XPOST localhost:$P/api/v1/toplog/persist -H 'content-type: application/json' -d '{"persist":true}'` |

   `on` needs the master switch too, because a tag with `enabled: false` logs
   nothing. Tags the user names should be in `../tags.md`. If one isn't, say so
   and run `scan`, because a tag no code emits stays silent.
3. **Report the state the call returned**: which tags are on, the master switch,
   and persist. For `on`, also say where the lines land:
   `~/.flow/instances/<name>/logs/*.log`, with `toplog:` for backend lines and
   `toplog.client:` for frontend lines. Remind the user that a backend restart
   resets the tags unless persist is set.
