---
id: 82c86394-2fe6-45ff-818f-901e447bedce
name: message-formatter
description: >-
  Shapes every message you send for the user so the receiver gets it fast and acts on it
  fast — a Flowpad message, a reply, an email, a Slack, WhatsApp or Telegram text. Use it
  before every `flow conversation send/new/reply` and every channel send whose wording is
  yours: one line saying what they need to do, decide or know; a short summary only when
  needed; then just the details they need to act. Drops filler, never repeats the
  conversation title, puts bounded questions in a one-Submit form (`--form`) with defaults, and
  renders the right markup for the channel.
---

# Message formatter

A Flowpad message should feel like fresh air next to the long AI-written emails everyone gets.
The receiver understands it in one glance and acts on it right away. Short beats
complete-sounding. Every word must help them act. Write it the way a sharp colleague would
type it, not the way an assistant drafts a letter.

## The shape

1. **One-liner** — what they need to do, decide or know. Lead with the action or decision.
2. **Summary** — a few sentences on the issue. Only when the one-liner is not enough.
3. **Details** — what they need to act on their side: links, ids, paths, numbers, deadlines,
   options. Only what they need, as a short list.

Every part is optional. A simple message is the one-liner and nothing else.

## Keep it minimal

- No filler: no "Need your help", "Quick question", "Hope you're well", "Hi, just wanted to…",
  no sign-off, no "let me know if you have questions".
- The conversation title carries the subject (`--title` is a few words). Never repeat it in the
  text. If the one-liner would only restate the title, drop it and start with the summary.
- No summary that repeats the one-liner. No details the receiver doesn't need to act.
- Don't announce what follows ("Here are the details:") — just give them.
- Plain words. Short sentences.

## Never sound like AI

- No greeting paragraph, no "I hope this message finds you well", no "I wanted to reach out".
- No hype or padding words: "delve", "seamless", "robust", "leverage", "crucial", "comprehensive",
  "I'd be happy to", "feel free to".
- No closing offers ("Let me know if you need anything else!") and no recap of what you just said.
- Don't bold every phrase or bullet every sentence; one bold line, a short list only for real items.
- No emoji decoration, no headings in a short message.
- Never explain that an AI or assistant wrote it.

## A light positive touch — only when earned

When the message closes a real success or answers real help — they shipped, fixed, approved,
or unblocked something, or you are reporting work that actually landed — add ONE light touch:
a ✅ or 👍, or a few kind words ("Nice catch.", "Thanks — that unblocked it.").

- Never by default. Routine FYIs, questions, requests and bad news get none.
- One touch per message, at most. Never two emoji, never stacked praise.
- Concrete, not gushing: thank them for the specific thing ("Thanks for the quick review"),
  never "Amazing!!", "Great job!", "You're awesome".
- Only for a confirmed outcome. Pending, partial or unsure → no ✅.

The "no emoji decoration" rule still holds; this one earned mark is the only exception.

## Your wording only

- Text the user dictated word for word goes out as written. You may format around it, never
  rewrite it.
- Never invent a fact, deadline or option to fill a section. Missing → leave the section out.
- A prompt the receiver should run is not wording: send it in its own field (`--prompt`),
  never as a code block in the text. The text just says what it does.
- Questions with bounded answers are not wording either: they go in a form (`--form`, below).

## A reply stays in its conversation

When the message answers one the user received, or follows up on it, send it in that same
conversation as a reply (`flow conversation send <conversation> "<text>" --reply-to <message id>`),
even when the subject has moved away from the conversation's title. Start a new conversation only
when the user explicitly asks for one.

## Questions → a form (Flowpad messages)

When you ask the receiver anything with a bounded answer — pick, number, date, yes/no, a value you can
guess — send ONE form with the message (`--form`), not questions in the text. They answer in place and
one **Submit** sends the answers back as a reply you read typed (`flow conversation show`: `✅ answers …`).

- The text is the one-liner (why you ask). Never repeat the questions in it.
- **Default every field you can infer** — from the conversation, their profile, the obvious choice. Leave
  `default` out ONLY when you truly can't tell; that field must be filled, so it is the decision you need.
- Most info per token and per click: short labels (≤3 words); prefer `one`/`buttons`/`yesno` over
  `text`; no `hint` unless the label is ambiguous; ≤7 fields; drop what you can decide yourself.
- `optional: true` only for extras (a note, a screenshot).
- Act on the LATEST answers — the receiver may change them; a change arrives as a new reply.
- WhatsApp, Telegram, Slack, email: no forms there — ask in the text as today.

| type | use for | value |
|---|---|---|
| `text` / `long_text` | a short / long free answer | string |
| `number` (`min`, `max`) | a count or amount | number |
| `date` | a day | `YYYY-MM-DD` |
| `yesno` | a yes/no decision | `true`/`false` |
| `one` / `buttons` / `select` | pick one (`options`); buttons for 2–4 quick picks, select for many | an option |
| `many` | pick several (`options`) | list of options |
| `file` | a screenshot or file they attach | file name (the file rides on the reply) |

```bash
flow conversation send <id> "Local deployment is up — a few answers before I switch it to cloudtest." \
  --form '{"title": "Before the switch", "fields": [
    {"id": "tenant", "label": "Tenant", "type": "one", "options": ["cloudtest", "local"], "default": "cloudtest"},
    {"id": "homes", "label": "Test homes", "type": "number", "min": 0, "max": 20, "default": 5},
    {"id": "on", "label": "Switch on", "type": "date"},
    {"id": "qa", "label": "Run QA after", "type": "yesno", "default": true},
    {"id": "shot", "label": "Screenshot", "type": "file", "optional": true}]}'
```

## Markup per channel

- **Flowpad and email** — Markdown: the one-liner in **bold**, the summary as a short
  paragraph, details as `-` bullets.
- **Slack** — mrkdwn: `*bold*` one-liner, `-` bullets, links as `<url|text>`.
- **WhatsApp and Telegram** — `*bold*` one-liner, plain line breaks, `-` bullets. No headings,
  no tables, no Markdown links (paste the URL).

## Examples

**An FYI** — "tell Dana the deploy moved to Thursday"

```
Deploy moved to Thursday.
```

Not: "Hi Dana! Hope you're well. Just a quick update: the deploy has been moved to Thursday. Let me know if you have questions!"

**A decision** — title `Logo pick`

```
**Pick logo A or B by Friday.**

Both pass the brand check; A is the one marketing prefers.

- A: https://example.com/logo-a
- B: https://example.com/logo-b
```

with `--form '{"title": "Logo", "fields": [{"id": "logo", "label": "Logo", "type": "buttons", "options": ["A", "B"], "default": "A"}]}'`

Not: "Need your help with something" or "Logo pick: I need you to pick a logo".

**A task** — title `Invoice 1042`

```
**Approve invoice 1042 ($3,200) in the billing portal.**

- Vendor: Acme Corp
- Due: Nov 5
- Portal: https://billing.example.com/invoices/1042
```
