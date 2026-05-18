---
id: e6bc9f1f-1e3b-50ff-b601-fa8c98366fbf
name: session-context-init
description: Injects session_id into flow_context on session start
---

## Triggers
- Hook events: SessionStart
- Condition: Always triggers on SessionStart

## Actions
- Writes session_id to flow_context.json
- `add_context`: Confirms session initialization
