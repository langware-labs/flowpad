---
id: 4f5f59c0-8321-4690-b0f4-19d55fa187e6
name: ask-for-help-routing
description: "Where a help request goes today, from the click to the hub. The user picks a help desk, people, or nobody. A desk request becomes a ticket in the nearest configured desk, and Flowpad support is the last fallback. Read from the code on 2026-11-18."
format: flowchart
session: cb455f48-3c7e-4352-9f5c-a83fcc90d6d3
---
The real flow, kept to the questions that decide where a help request goes. The state that answers each question and the details are beside the flow, not in it. Sources: `flow_sdk/app/actions/ask_for_help_action.py`, `flow_sdk/app/actions/flow_message_action.py` (`resolve_helpdesk`), `flow_sdk/app/helpdesk_resolver.py`, `ui/src/components/help/AskForHelpDialog.tsx`, hub `flowpad/config.py`.
