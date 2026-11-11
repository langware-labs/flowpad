---
id: e0ebbe9b-4ef4-49ba-a62b-604018373036
---

# Prompt request vs live session (two users, real hub)

A plain prompt is a **prompt request**: a one-prompt session the recipient answers
once. A **live session** (the composer's live-session button) is unchanged and has
no prompt limit. Automated twin: `ui/tests/hub_playwright/prompt_request.spec.ts`.

## Prereqs

- Local hub on `:8093`.
- Two instances of this checkout, cloud-logged-in to that hub, launched one after
  the other: `scripts/instance_ctl.sh launch pra-1` (sender, "alice") and
  `scripts/instance_ctl.sh launch prb-2` (recipient, "bob").
- A conversation between them; on bob, the conversation is mapped to a project.

## 1. Run & Update

1. Alice: `FLOW_INSTANCE=pra-1 flow conversation send <conv> "Run this when you can." --prompt "Reply with exactly PR-1"`.
2. PASS when alice's conversation shows her message (text + "Prompt to run: …") and under it
   `Prompt request · prb-2 ● waiting for prb-2 [Cancel]`.
3. PASS when bob sees the same message and `Prompt request · pra-1 ● not run yet
   [Run & Update pra-1] [Run] [Decline]` — no "Live session", no "Needs your approval".
4. Bob clicks **Run & Update pra-1**.
5. PASS when alice's row turns `running · m:ss [Open] [Cancel]`, then `done [Open]`, with
   "Update from prb-2 — PR-1" under it; bob's row reads `done` with "✓ Update sent to pra-1".
6. PASS when bob's session row (`GET /api/v1/graph/remote_worker_session/<id>`) is
   `status=ended, prompt_limit=1, prompts_used=1, reply_policy=auto`.

## 2. Run (nothing goes back)

1. Send another prompt; bob clicks **Run**.
2. PASS when bob's row reads `done` with no "Update sent" line, alice gets no update, and the
   session is `ended`, `reply_policy=review`, `prompts_used=1`.

## 3. Decline / Cancel

1. Send a prompt; bob clicks **Decline** → PASS when both rows read `declined`.
2. Send a prompt; alice clicks **Cancel** before bob answers → PASS when bob's buttons disappear
   and the row reads `cancelled`; nothing runs (`prompts_used=0`).

## 4. Separate requests, and a live session stays live

1. Send two prompts back-to-back → PASS when there are two rows with two different session ids,
   each answered separately.
2. Alice opens a live session from the composer's live-session button, bob approves; then alice
   sends a plain prompt → PASS when it joins the live session (no new Prompt request row), the
   live session stays `idle` (not ended) with `prompt_limit` empty, and `prompts_used` counts 2.

## 5. A prompt into an ended request never runs

1. After 1., post a prompt into the ended session id (`add_message` with
   `remote_worker_session_id=<ended id>`) → PASS when it is refused with 409
   "this live session has ended — send a new prompt to start another".
