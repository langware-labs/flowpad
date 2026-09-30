---
id: 3f5ef879-f39f-4ab4-b295-f4bb16da3f60
---
# Validation loop — the user tests, you tighten

The agent is finished when the user has watched it follow its rules, not when its
files exist. The user drives the chat; you write the script, read what came back and
change the prompt.

## 1. Write the test script

Derive 4–6 turns from the prompt itself — one per rule that matters:

- **Normal request** — the everyday thing the agent is for.
- **Rule-break attempt** — the user tries to get what the agent must refuse.
- **Edge case** — empty input, a wrong guess, an off-topic question, a state the
  agent has not seen.
- **One per response kind** — each event or reply type the prompt defines.

Hand it to the user in exactly this shape:

```markdown
## Test script — <agent name>, round <n>

| # | Type this (or do this) | A good reply… | A bad reply… |
| --- | --- | --- | --- |
| 1 | <normal request> | <what the rule expects> | <the failure to watch for> |
| 2 | <rule-break attempt> | <refuses warmly, gives the next allowed step> | <gives in> |
| 3 | <edge case> | … | … |

## What to send me back
The reply number and what looked wrong — or "all good".
```

## 2. The user runs it

Open the agent's chat for them (`references/screens.md` → *Chat with it*), then wait
for their report. Let them type every turn and quote the replies back to you: the test
measures what a real user gets, which your own messages in that chat would change.

## 3. Tighten one thing at a time

For each reply the user flags:

1. Name the rule it broke, in one line.
2. Change the prompt at the section that owns that rule — usually an added literal
   example or a disguised form made explicit (`references/prompt-skeleton.md`).
3. Tell the user which turn to repeat.

One change per round keeps each fix attributable: two edits at once hide which one
worked and which one broke something else.

## 4. Repeat

Run at least two rounds. After each change, re-run every turn of the affected
response kind, not only the one that failed — a tightened rule often breaks its
neighbour. Stop when a full round comes back "all good".

A prompt edit applies to the **next** session. A new chat from the agent's tile starts
with the auto prompt too, so re-test there; reset auto-launch only to re-test the
launch itself (`references/screens.md`).
