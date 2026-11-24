# Ontology refactor

The classifier left some conversations without a tag. You change the tag tree so each of them has one — by
defining new tags in the best place in the hierarchy. You still write nothing: every tag you define is an
`added` entry in the value's `tree_changes`, and a person approves it.

## What you work from

- The tag tree, exactly as `CTL tree` printed it: each tag's full name and meaning.
- The **unplaced** rows: `proposed` is empty. For each: its `title`, its `reason` (why nothing fitted), and
  its `request` if the agent made one. Read a conversation again (`CTL conversation <id>`) when the reason is
  not enough to name what it is about.
- The `request` of every other row: a tag an agent wanted, while it sits on a fallback.

## Define the tags

1. **Group first.** Put the unplaced conversations that are about the same thing together; two agents asking
   for `refund` and `money-back` mean ONE tag. One tag for several conversations beats one tag each — but a
   conversation that stands alone still gets a tag: none is left out.
2. **Place each tag.** A tag goes UNDER the broadest existing tag it is a kind of
   (`stream_inbox.support.billing.refund`, not a new root beside `support`). A root-level tag is for a new
   family only — something no existing tag is the parent of. A flat list of unrelated roots is a sign you
   skipped this.
3. **Write its meaning for the decision model.** One line saying what a message under this tag says, in the
   words such a message uses, and specific enough to tell it from its parent and its siblings. The decision
   model picks a tag from the meanings alone.
4. **Record it**: `{"op": "added", "tag": "<full name>", "meaning": "…", "reason": "<why here, and why no
   existing tag>", "asked_by": <how many conversations it catches>}`.
5. **An existing tag is still the first choice.** If, reading the group, an existing tag does mean it, use
   that tag and add nothing.

## Give every row its tag

- Each unplaced row: `proposed` is its tag, and `reason` says in one sentence what it is about and why this
  tag. A row whose agent asked for a tag carries `"asked": {"tag", "meaning", "answer": "approved"}` when you
  made that tag (under whatever name you gave it), or `{…, "answer": "use_existing", "use": "<tag>"}` when you
  placed it on another one.
- A row sitting on a fallback whose request you made a tag for moves to that tag, with `"answer": "approved"`.
- Continue an asking agent with its answer only when you need its final `reason`; you may write the reason
  yourself.

Done when no row has an empty `proposed`. Go back to the skill: assemble, check, validate.
