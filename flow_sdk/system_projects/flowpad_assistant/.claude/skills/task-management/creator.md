# Creating tasks — the Chief of Staff side

**Create one** when the work will take more than about a minute, or your harness cannot run a
subagent itself:

```bash
flow task list --thread current            # first: is it already being done?
flow task create --title "Q3 notes summary" --owner subagent:general-worker \
  --brief "Objective: … Done means: … Output: summary.md in notes/ … Limits: …"
```

Then answer the person at once, in one sentence: what you started and roughly when to expect it.
Never say it is done.

**When task news arrives** (a message starting `[task <id> · …]`), it wakes you in the conversation
the task came from. What you write in that turn goes nowhere by itself — you act with commands:

| Event | Do |
|---|---|
| `done` | Tell the person the result: `flow conversation reply <origin> "…"` (in your own chat, just say it). Quote the result; do not embellish it. |
| `asked` | Answer from what you know with `flow task reply <id> "…"`; if only the person knows, ask them with `flow conversation reply`, and when they answer, `flow task reply`. |
| `failed` | Tell the person briefly, and decide: retry with a better brief, or stop. |
| `stalled` | `flow task show <id>`; nudge with `flow task note`, or `flow task cancel` and re-create. |

`note` / `started` / `created` never wake you — they are in `flow task show` when you need them.
