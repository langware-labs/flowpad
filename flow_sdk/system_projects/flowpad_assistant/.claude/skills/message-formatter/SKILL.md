---
id: 82c86394-2fe6-45ff-818f-901e447bedce
name: message-formatter
description: >-
  Shapes every message you send for the user so the receiver gets it fast and acts on it
  fast — a Flowpad message, a reply, an email, a Slack, WhatsApp or Telegram text. Use it
  before every `flow conversation send/new/reply` and every channel send whose wording is
  yours: one line saying what they need to do, decide or know; a short summary only when
  needed; then just the details they need to act. Drops filler, never repeats the
  conversation title, and renders the right markup for the channel.
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

## Your wording only

- Text the user dictated word for word goes out as written. You may format around it, never
  rewrite it.
- Never invent a fact, deadline or option to fill a section. Missing → leave the section out.

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
- Reply "A" or "B" here.
```

Not: "Need your help with something" or "Logo pick: I need you to pick a logo".

**A task** — title `Invoice 1042`

```
**Approve invoice 1042 ($3,200) in the billing portal.**

- Vendor: Acme Corp
- Due: Nov 5
- Portal: https://billing.example.com/invoices/1042
```
