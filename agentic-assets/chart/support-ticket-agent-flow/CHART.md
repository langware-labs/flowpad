---
id: 2b10d725-f169-4b44-b0c4-c528984d852e
name: support-ticket-agent-flow
description: "The defined help desk flow with two agents. The external agent talks to the user, the internal agent runs the RCA and reports to the team. It starts when a user opens a request and ends when the ticket and the internal ticket are closed."
format: sequence
session: cb455f48-3c7e-4352-9f5c-a83fcc90d6d3
---
Target design, not what the code does today. External agent = the support agent the user sees. Internal agent = works with the team in the internal conversation. The RCA loop (steps 4 to 10) repeats until the RCA is clear.
