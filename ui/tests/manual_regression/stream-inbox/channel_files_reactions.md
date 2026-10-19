---
id: 871d15b9-44ab-48da-a882-66a0e31df494
---
# Channel files, quotes and reactions — in the browser

precondition: as `channel_matrix.md` — an isolated instance (`scripts/instance_ctl.sh launch <name>`) and the
channel doubles process (`tests/e2e/channel_doubles.py`, spawned by the `.md.ts`), which hosts every driver's
`Double`. What is proved, per channel (whatsapp, telegram — the two that quote and react):

- a person's PHOTO arrives: the conversation shows the picture itself (`img[alt=<name>]`, decoded), copied to
  this machine while the provider's session was open;
- a person's REPLY that quotes the photo shows the quote block (`message-quote`) naming the quoted words;
- we REACT from the bubble's hover action (`message-react` → 👍 in the picker): the double records the
  reaction on the photo's message, and the chip (`reaction-👍`, pressed) shows on the bubble;
- the person's reaction (❤️, `/react` on the double) shows as a chip after the next sync;
- we REPLY to the photo with a file: Reply (`message-reply`) opens the banner (`composer-reply-banner`),
  the paperclip is live (the channel `accepts_attachments`), a PNG is attached and sent — the double
  records the file and the quote of the photo's message.

| channel | test |
|---|---|
| whatsapp | test 1 |
| telegram | test 2 |

test N:
- [api] `POST /graph/data_source` with the double's config, owner = the local user; verify
- [api] doubles `POST /deliver {channel, text, files: [photo.png]}`; sync; then `POST /deliver {channel, text,
  reply_to: <photo's external id>}`; sync
- [browser] open the conversation from `/dock/stream_inbox`; the photo renders; the second bubble quotes it
- [browser] hover the photo's bubble → React → 👍; [api] doubles `GET /reactions?channel=` holds 👍 on the photo
- [api] doubles `POST /react {channel, target: <photo>, emoji: ❤️}`; sync; [browser] the ❤️ chip shows
- [browser] Reply on the photo → banner; attach `reply.png`; type; Send; [api] `GET /sent` holds the file
  and quotes the photo
- [api] delete the source
