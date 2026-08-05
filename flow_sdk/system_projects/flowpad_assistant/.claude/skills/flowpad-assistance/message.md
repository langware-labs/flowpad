# Action: message

Send a message — optionally with file attachments, entity references, or a runnable prompt —
into a Flowpad conversation, on behalf of the user. Triggered by "send X to my conversation
with Y", "attach this doc to the Z conversation", "message Y the report", "send them a prompt
to run".

`flow conversation send <conv-id> <text>` exists and is fine for a **text-only** send. It
takes no attachment, asset or prompt options, so every richer send goes through the backend's
own `add_message` action — the same endpoint the UI uses — called over local HTTP. Prefer the
HTTP path whenever the message carries anything besides text, so one shape covers every case.
Everything below is one `curl` per step.

## Step 0 — resolve the backend port

The backend is instance-scoped. Read the port from the instance's `server.json`:

```bash
PORT=$(python3 -c "import json,os,pathlib; inst=os.environ.get('FLOW_INSTANCE','prod'); print(json.load(open(pathlib.Path.home()/'.flow'/'instances'/inst/'server.json'))['port'])")
BASE="http://localhost:$PORT/api/v1"
```

If `server.json` is missing, that instance's backend is not running — stop and tell the user.

## Step 1 — resolve the conversation id

If the user gave an explicit conversation id (or a `conversation-<uuid>` TypeId), use it.
Otherwise resolve by participant or title from the local conversation list:

```bash
curl -s --max-time 15 "$BASE/graph/conversation" | python3 -c "
import json,sys
needle = 'NEEDLE'.lower()   # participant email/name fragment or title fragment
for c in json.load(sys.stdin)['data']:
    parts = c.get('participants') or []
    hay = ' '.join([c.get('title') or ''] + [p.get('email','')+' '+p.get('name','') for p in parts]).lower()
    if needle in hay:
        print(c['id'], '|', c.get('title'), '|', c.get('updated_date'), '|', [p.get('email') for p in parts])
"
```

- "my latest conversation with Y" → among the matches, pick the **max `updated_date`**.
- Multiple plausible matches with similar recency → list them and ask the user; do not guess.

## Step 2 — check cloud login (sends require it)

```bash
curl -s --max-time 15 "$BASE/cloud/status" | python3 -c "import json,sys; d=json.load(sys.stdin)['data']; print(d.get('logged_in'), d.get('hub_ws_status'))"
```

If `logged_in` is not `True`, stop and ask the user to sign in (Flowpad UI cloud sign-in, or
`flow auth login`). Do not retry until they confirm. (A backend restart loses cloud login —
this is the most common failure.)

## Step 3 — send

One endpoint carries every kind of send; pick the payload keys for what you are attaching:

| Key | Carries | Notes |
| --- | --- | --- |
| `message` (alias `text`) | the text body | required unless a prompt / file / asset is attached |
| `files` | an on-disk file, uploaded | repeatable, one field per file |
| `asset_references` | a Flowpad entity, referenced not uploaded | its TypeId, e.g. `markdown-<uuid>` |
| `prompt_text` | a runnable prompt for the recipient | minted as a real `Prompt` entity, attached as a `type_id` with an inline `prompt_preview` |
| `prompt_files` | prompt bodies read from files | text files become `Prompt` entities; images stay raw |

Multipart when the send uploads files:

```bash
curl -s --max-time 15 -X POST "$BASE/graph/conversation/<CONV_ID>/add_message" \
  -F 'message=<short intro text for the recipient>' \
  -F "files=@/abs/path/to/doc.md" \
  # repeat -F "files=@..." per extra file
  # entity reference instead of a file:  -F 'asset_references=markdown-<uuid>'
```

A JSON body is accepted for everything that is not a file upload, and is the right shape for
long multi-line text — quoting a prompt through repeated `-F` flags is where these sends break:

```bash
curl -s --max-time 180 -X POST "$BASE/graph/conversation/<CONV_ID>/add_message" \
  -H 'Content-Type: application/json' --data @payload.json
# payload.json: {"text": "<what the human reads>", "prompt_text": "<what they run>"}
```

Keep the split honest when the user asks for a message *with* a prompt: `text` is the part the
recipient reads, `prompt_text` is the part they execute. Putting run instructions in `text`
gives them nothing to run; putting the explanation in `prompt_text` buries it in an attachment.

Expect `{"status": "SUCCESS"}`. `"Cloud login required to send messages"` → back to Step 2.
The attachment bundle (`body.flowmsg`) is built and uploaded to the hub in a background task —
no extra call needed. Allow a generous client timeout: packing a bundle or summarizing an
attached transcript happens inside this one call and can take a minute.

## Step 4 — verify (always)

The success response carries `flow_message_id` (or `id`) and the `attachment` list — read the
new message id straight off it. It also carries `delivery_status`, and on a healthy send that
value is usually still `created`: the hub push and its confirmation land a second or two after
the response returns. **Never report a send as failed on the response's `delivery_status`** —
re-read the row (below) and let it settle to `sent`.

Fall back to walking the conversation when the response is missing the id, then confirm the
attachment and upload state on the row itself:

```bash
curl -s --max-time 15 "$BASE/graph/conversation/<CONV_ID>" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
ids=d.get('message_ids') or []
ids=json.loads(ids) if isinstance(ids,str) else ids
print(ids[-1]['typeid'])
"
# then, with FM_ID = uuid part of that typeid:
curl -s --max-time 15 "$BASE/graph/flow_message/<FM_ID>" | python3 -c "
import json,sys
d=json.load(sys.stdin)['data']
print('delivery_status:', d.get('delivery_status'), '| body_status:', d.get('body_status'))
print([(a.get('attachment_type'), a.get('data')) for a in d.get('attachment') or []])
"
```

Done when `delivery_status` is `sent` (the hub accepted it) **and** the body has settled:
`body_status` is `ready` for a send that carries a bundle, or `na` when nothing rides one
(text-only, or inline-only attachments). Then check the attachment list matches what you sent —
`('file', 'data/<your-filename>')` for an upload, `('type_id', 'prompt-<uuid>')` for a prompt.
Report the message id and what the recipient can now do with it (download, run the prompt).
If `delivery_status` stays `created` or `body_status` stays `uploading`, report that honestly —
do not mark the send verified.

## Error map

| Symptom | Meaning | Do |
| --- | --- | --- |
| `Cloud login required to send messages` | backend not cloud-logged-in (e.g. after restart) | Step 2: ask user to sign in, then retry |
| `Conversation not found: <id>` | wrong id / wrong instance | re-run Step 1; confirm `FLOW_INSTANCE` |
| connection refused on `$BASE` | backend down | tell the user; do not start servers yourself |
| `message, prompt, files, or asset_references required` | empty send | provide at least one of `message`/`text`, `files`, `asset_references`, `prompt_text` |

<!-- flowpad:capsule identity
version: 1
data:
  id: 848f6599-1d14-4999-9fff-4b40359eb22b
flowpad:endcapsule identity -->
