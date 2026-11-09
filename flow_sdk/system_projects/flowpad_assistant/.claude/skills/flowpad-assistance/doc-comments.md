# Action: doc comments

A doc's comments are a layer over its text: each one quotes a passage and is drawn
in the doc right under it. The markdown file is never written — so to ask the person
something about a doc, comment on it instead of editing questions into the file.

Kinds: `questions` (a form the person answers in the doc), `text` (a note),
`change_request` (the person's "change this" — you receive those, you do not write them).

## Ask questions on a doc

```bash
flow record comment add <doc typeid> "One line on why you ask" --kind questions \
  --quote "<exact text of the passage it is about>" \
  --form '{"form_id":"launch","title":"Launch decisions","fields":[
    {"id":"date","label":"Launch date","type":"date"},
    {"id":"ch","label":"Channels","type":"many","options":["Email","Slack"],"default":["Email"]}]}'
```

- `--quote` must be text that is in the doc now, word for word (one paragraph).
- Field types: `text long_text number date one many yesno buttons select`; a field with a
  `default` is pre-filled, one without must be filled. Bad input is refused with the reason.
- The person answers in the doc and presses Send; the answers come back to your session
  as one turn that names each comment id.

## When a turn hands you comments

Do what each one asks, then report in its own thread — one line, single quotes so the
shell keeps `$` and `!`:

```bash
flow record comment reply comment-<id> 'Launch set to Dec 1, Slack added.'
flow record comment status comment-<id> done      # or: failed (say why in the reply)
```

The reply links to this turn of your chat, so keep it short — the detail stays in the chat.

`flow record comment list <doc typeid>` reads every comment and reply on a doc.
