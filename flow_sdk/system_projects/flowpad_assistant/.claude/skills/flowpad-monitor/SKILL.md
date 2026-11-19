---
id: e1398283-ae08-4d2b-b31d-c410ab6deb97
name: flowpad-monitor
description: >-
  Keep THIS session working until a goal is met — `flow process monitor` checks it on a cron and prompts the
  session to continue until done. Use when the user says to finish a unit of work "until it's done" / "keep going
  until X", or gives a clear stop condition. NOT for a one-time later check (`flow process schedule`) or waiting
  for a person's reply (`--on-reply`).
---

# Monitor a goal until it is done

```
flow process monitor --name <short-name> --goal "<what done looks like>" [--stop-condition "<when to stop>"] --cron '*/10 * * * *'
```

- Run it from the session doing the work (`-p` defaults to it). It prints a `key`; keep it.
- Word the goal so it can be checked from the conversation: "all tests in tests/unit pass", not "make it better".
  Give a stop condition when the user named one ("stop after 3 failed attempts", "stop at 18:00").
- Pick the cron to match the work: `*/10 * * * *` for coding loops, hourly for slow jobs.
- On each tick, while you are idle, a fork of this session judges the goal. Not met: you get a prompt to continue —
  just continue. Met or stop condition reached: the monitor removes itself, quietly.
- Done early, or the user changes their mind: `flow process unmonitor <key>`.
- Never run `flow process monitor-nudge` yourself — the trigger runs it.
