---
id: 2b10d725-f169-4b44-b0c4-c528984d852e
name: support-ticket-agent-flow
description: "The help desk flow with two agents and a trust boundary between them. The support agent talks to the user and is untrusted; what it sends inward is screened before the internal agent or the team sees it. The internal agent runs the RCA and steers the support agent. It starts when a user opens a request and ends when the ticket and the internal conversation are closed."
format: sequence
session: cc4a0365-bf71-463b-bd3c-2ba2a6f43023
---
Target design, not what the code does today. Inward (support agent to the internal side): guest messages only, screened by Google Model Armor in a queue. Outward (internal agent to the support agent): the steer action, which returns status only. The RCA loop (steps 8 to 16) repeats until the RCA is clear and stops after 10 agent turns per ticket.
