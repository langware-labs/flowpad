---
id: a85e3168-8371-463a-96f0-2bc641963a66
name: stream-inbox-classifier
description: >-
  Auto-classifies Stream Inbox conversations — "classify these conversations", "tag my Stream Inbox from the
  last week", "auto-tag the conversations of this window", "review my Stream Inbox tags". One Haiku agent reads
  each conversation and proposes its tag; you, the main agent, keep the tag tree small — a new tag needs
  your approval — and return ONE checked value, kind stream_inbox.classification: conversation x tag plus
  the tag tree changes. It only proposes; a person applies. NOT for defining tags by hand or running the
  classifier's eval (the tag editor), or for message automations.
version: 1
---

# stream-inbox-classifier

You are the **main agent**. You receive a list of conversations (ids), or a window (`since` / `until`), and
return one value of kind `stream_inbox.classification`. **You write nothing to the Stream Inbox or the tag tree** —
no `flow tag create`, no `set-tags`. The value is a proposal a person applies.

`CTL` below is `"$FLOWPAD_PYTHON" <this skill>/scripts/stream_inbox_ctl.py` — one JSON object per call.

## 1. Read the ground

```bash
CTL tree                                      # {root, tags: [{name, meaning}]} — the ontology
CTL conversations --since 2026-11-09 --until 2026-11-14   # only when you were given a window, not ids
```

## 2. One agent per conversation

Launch one `conversation_tagger` subagent per conversation, in parallel batches of up to 10. Give each:
the conversation id, the tree exactly as `CTL tree` printed it, and the path of this skill's `stream_inbox_ctl.py`.
It answers with one JSON object:

```json
{"conversation_id": "…", "message_id": "…", "title": "Dana Levi — charged twice", "before": [],
 "proposed": ["stream_inbox.support.billing"], "reason": "One sentence.",
 "request": {"tag": "stream_inbox.support.refund", "meaning": "Asks for money back", "fallback": "stream_inbox.support.billing"}}
```

`request` is there only when no existing tag fits well: the tag it wants, and the best existing tag meanwhile.

## 3. Keep the tree small — you decide every request

A tag is ONE at most per conversation; none is a valid answer. Settle the requests of a batch together:

- **Approve** a new tag only when it names something no existing tag means AND more than one conversation
  asks for it or would fit it. Approving records `{"op": "added", "tag", "meaning", "reason", "asked_by": n}`.
- **Give the tree its shape.** A new tag goes UNDER the broader tag it is a kind of — an existing one, or one you
  approve in this run (`stream_inbox.engineering.ci`, not a second root tag beside `engineering`). A root-level tag
  is for a new family only. A flat list of unrelated roots is a sign you skipped this.
- **Answer "use X"** otherwise: an existing tag, or a tag you approved earlier in this run with the same
  meaning (two agents asking for `refund` and `money-back` get ONE tag). The row then carries
  `"asked": {"tag", "meaning", "answer": "use_existing", "use": "X"}` and proposes X.
- Send each asking agent its answer (continue that agent) and take its final row, so its `reason` matches.
  An approved request's row carries `"asked": {…, "answer": "approved"}`.
- You may also propose, each with a `reason`: `updated` (a meaning two tags are confused by — `was` = the
  old meaning), `moved` (`was` = the old full name), `removed` (a tag another one already means —
  `merged_into` says where its conversations go). Never more than the conversations in front of you justify.

## 4. Assemble and check

```json
{"root": "stream_inbox", "since": "2026-11-09", "until": "2026-11-14",
 "conversations": [{"conversation_id", "message_id", "title", "before", "proposed",
                    "action": "keep|apply|change|remove", "reason", "asked"?}],
 "tree_changes": [{"op": "added|updated|moved|removed", "tag", "was"?, "meaning"?, "merged_into"?, "reason", "asked_by"}]}
```

`action` is derived, never chosen: `keep` (before = proposed), `apply` (had none), `remove` (proposes
none), `change` (otherwise). Then:

```bash
CTL check <file>      # {"fits": true} — or the errors, by row. Fix the VALUE and check again until it fits.
```

Never hand over a value that did not fit. A conversation whose agent failed is left out and named in your reply.

## 5. Hand it over

```bash
CTL submit <file>     # {"fits": true, "ref": "stream_inbox.classification.id.<uuid>"} -- kept, and posted as a message
```

The value is too big to return itself: your answer is its reference. When your run was told where to write
its result, write `{"ref": "<the ref>", "conversations": <how many>}` there. End with one line: how many
conversations, how many would change, and each tree change.
