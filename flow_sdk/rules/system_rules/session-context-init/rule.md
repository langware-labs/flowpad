---
name: session-context-init
description: Injects session_id into flow_context on session start
---

## Triggers
- Hook events: SessionStart
- Condition: Always triggers on SessionStart

## Actions
- Writes session_id to flow_context.json
- `add_context`: Confirms session initialization
