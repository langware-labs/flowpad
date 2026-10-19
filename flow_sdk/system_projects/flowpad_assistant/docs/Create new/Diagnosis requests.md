---
id: e8ffbdae-eb58-4cb4-8b8b-867218959a71
title: Diagnosis requests
---

# Diagnosis requests

A **diagnosis request** lets you diagnose Flowpad on someone else's computer. You write
what their agent should do; they run one command; you read what came back.

## Opening one

**Create new → Diagnosis request**:

- **Instructions** — what their agent is asked to do, one step per line.
- **Send along** — files from your computer and skills their agent gets for this run only.
- **Accepts runs for** — how long the request takes runs (48 hours by default, 7 days at most).
- **Pay for their LLM** — for someone with no token source of their own: a capped, expiring
  budget they spend by the request id. Drawn from a hub budget you may hand out, or from an
  LLM key on your computer (uploaded to the hub; they never see the key).

## Sending it

The request's screen shows the command to send — `flow diagnose <id>`. They run it in
their terminal; no Flowpad account is needed.

## Reading the runs

Every run is kept. Open the request from **Diagnosis requests** in the assets list to see
each run's summary, root cause, fix and the files it attached.
