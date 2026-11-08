---
id: e4c512cf-7119-4443-9a84-73b3de1cb0e8
title: IT Enabled
---

# IT Enabled

**IT Enabled means this machine accepts IT messages from its owner.** An IT message is one request — a prompt, maybe files and an answer shape — that the owner of a deployed agent sends to its machines at once, for example a teacher asking every student machine "how far did this student get?". Each machine answers in a short session of its own, and the answers come back as one **IT conversation** in the owner's StreamInbox.

- **Who can send one:** only the owner of the agent the machines were deployed from.
- **Never while someone is signed in.** A machine with a person signed in refuses every IT message, even when IT Enabled is on.
- **Nothing is kept on the machine.** The IT session runs, answers, and is deleted: no session, no records, nothing in that machine's StreamInbox. Only what it was asked to change stays changed.
- **IT Disabled** machines refuse: their reply reads "IT is disabled on this machine".

## Turning it on or off

- **From the deployments list** (the agent's Auto-launch tab): each machine shows **IT Enabled** or **IT Disabled**; click it to switch. "IT —" means the hub has not seen that machine's setting yet.
- **On the machine itself:** Preferences → General → **IT Enabled**. Off by default.
- **From an IT conversation:** a reply that says "IT is disabled on this machine" has **Enable and run** — it enables that machine and asks it the same request again, in the same conversation.

## Paused machines

A paused machine is woken to answer an IT message; its reply says so. Opening the deployments list never wakes a machine — a paused one shows the last state the hub saw.
