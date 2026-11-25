---
id: a85e3168-8371-463a-96f0-2bc641963a66
name: stream-inbox-classifier
description: >-
  Auto-classifies Stream Inbox conversations — "classify these conversations", "tag my Stream Inbox from the
  last week", "auto-tag the conversations of this window", "review my Stream Inbox tags". One Haiku agent reads
  each conversation and proposes its tag; you, the main agent, define a new tag in the tag tree for every
  conversation no tag fits (the ontology refactor), check each tag with the decision model, and return ONE
  checked value, kind stream_inbox.classification: conversation x tag plus the tag tree changes. It only proposes; a person applies. NOT for defining tags by hand or running the
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

`request` is there only when no existing tag fits well: the tag it wants, and the best existing tag meanwhile
(`proposed` holds that one, or nothing).

## 3. Ontology refactor — no conversation is left without a tag

"No tag fits" is not an answer this skill returns. Every row whose `proposed` came back empty is **unplaced**,
and every `request` is a hint. When there is at least one of either, read
[`commands/ontology-refactor.md`](commands/ontology-refactor.md) and follow it: it takes the tag tree and the
unplaced rows and defines the tags they need, each in its place in the tree. When every row has a tag and no
agent asked for one, skip this step.

You may also propose, each with a `reason`: `updated` (a meaning two tags are confused by — `was` = the
old meaning), `moved` (`was` = the old full name), `removed` (a tag another one already means —
`merged_into` says where its conversations go). Never more than the conversations in front of you justify.

## 4. Assemble and check

```json
{"root": "stream_inbox", "since": "2026-11-09", "until": "2026-11-14",
 "conversations": [{"conversation_id", "message_id", "title", "before", "proposed",
                    "action": "keep|apply|change", "reason", "asked"?, "validation"?}],
 "tree_changes": [{"op": "added|updated|moved|removed", "tag", "was"?, "meaning"?, "merged_into"?, "reason", "asked_by"}]}
```

`action` is derived, never chosen: `keep` (before = proposed), `apply` (had none), `change` (otherwise).
Every row proposes a tag; a value with an empty `proposed` does not fit. Then:

```bash
CTL check <file>      # {"fits": true} — or the errors, by row. Fix the VALUE and check again until it fits.
```

Never hand over a value that did not fit. A conversation whose agent failed is left out and named in your reply.

## 5. Validate — the decision model must find the tag

The tags are used by Flowpad's decision model, not by you: it reads one message and picks a tag from the
meanings alone. So the proposal is checked with it, against the tree as your value would leave it:

```bash
CTL validate <file>   # writes each row's `validation` into the file; prints {"checked", "not_detected": [{title, proposed, detected}]}
```

- A row on an **existing** tag that is not detected: leave it. Its `validation` rides with the row and the
  review marks it.
- A row on a tag **you added** that is not detected: the tag's meaning does not say what you meant. Rewrite the
  meaning (what a message under it says, in the words such a message uses; what tells it from its neighbours)
  and validate again — at most 2 rewrites per tag. Still not detected: keep the tag and the row as they are;
  the failed `validation` is how the reviewer learns of it. Never drop the tag, and never empty the row.

Run `CTL check <file>` once more after the last validate.

## 6. Hand it over

```bash
CTL submit <file>     # {"fits": true, "ref": "stream_inbox.classification.id.<uuid>"} -- kept, and posted as a message
```

The value is too big to return itself: your answer is its reference. When your run was told where to write
its result, write `{"ref": "<the ref>", "conversations": <how many>}` there. End with one line: how many
conversations, how many would change, and each tree change.
