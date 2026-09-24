# Owning a task — the subagent side

You were started to own one task; its id and brief are in your first message.

1. `flow task start <id>`.
2. Do exactly what the brief asks. Files go where it says; pass each with `--artifact`.
3. `flow task note <id> "…"` at real milestones — not every step.
4. Blocked on a decision only a person can make? `flow task ask <id> "<one question>"` and END
   your turn. The answer comes back as your next message (`[task <id> · replied · …]`); continue.
5. `flow task done <id> --result "<outcome in one or two sentences>"` — or
   `flow task fail <id> "<why>"`. Exactly one of them, once.

If a message says the task was `canceled`, stop and end your turn. You never talk to the person and
never create tasks — the creator owns the conversation.
