---
id: 7191615b-e393-441e-8cb8-5b40cef59271
---
# Two channels, one stream inbox — pages of 50, attribution per source

precondition: an isolated instance (`scripts/instance_ctl.sh launch drv-7`) served from a
PRODUCTION UI build (`npx vite build --mode drv-7 --outDir <scratch>` + `vite preview`); the
shared Vite cache is clobbered by other sessions' dev servers. Two `agent` sources exist —
`Support slack` (`connector: slack`, `mailbox: C0123ABCD`) and `Team mail` (`connector: gmail`,
`mailbox: INBOX`) — each holding 60 messages written through the ingest route
(`POST /api/v1/ingest/items`, 20 per call so every item is announced and projected; a call of 30+
is a BACKFILL that projects only on the next poll's reconcile sweep). Nothing polls them, so no
worker runs. Seed: `scratchpad/seed_drv7.py` in the session that wrote this page.

What is being proved: one source = one stream, and a stream inbox is the merge of an owner's
sources. Every row wears the chip of ITS source (`origin_local.data_source_id`, else channel);
the bar shows one mark per channel; a mark narrows to that source; the items route pages 50 at
a time.

test 1: the API pages a source's items 50 at a time
- [api] POST /api/v1/graph/data_source/<slack-id>/items {"limit": 50} — exactly 50 items, newest first (`slack message 059` … `slack message 010`)
- [api] the same for <gmail-id> — 50 of 60

test 2: the stream inbox merges both sources, attributed
- [browser] navigate to {APP_URL}/dock/stream_inbox
- [browser] validate the "All" tab counts 120 and data-testid="attached-channels" holds exactly two data-testid="attached-channel" marks, both data-provider="agent", data-state="on" (a Gmail glyph and a Slack glyph — the transport's per-channel icons)
- [browser] validate rows from both channels are listed, each with a data-chip-type="source" chip

test 3: a mark narrows to ONE source; × restores
- [browser] click the Slack mark: aria-pressed="true", the other mark dims, data-testid="attached-channels-clear" appears
- [browser] validate 60 rows remain, every chip reads "Slack", every sender is "Bob" (author_display), no "Subject N" (the mail) row is visible
- [browser] click ×: 120 rows again, both marks un-pressed

Verified 2026-09-17 on drv-7 (production build on :5017, backend :6007): tests 1–3 pass;
screenshot of test 3 with the Slack mark pressed and 60 Slack rows. The instance was killed
afterwards; nothing was written to a real project.
