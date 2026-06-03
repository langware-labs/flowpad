# Action: message

Send a message — optionally with file attachments — into a Flowpad conversation, on behalf
of the user. Triggered by "send X to my conversation with Y", "attach this doc to the Z
conversation", "message Y the report".

There is **no `flow` CLI command for this** (do not look for one). The canonical path is the
backend's own `add_message` action — the same endpoint the UI uses — called over local HTTP.
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

Multipart POST. `message` is the text body; each on-disk file is a repeatable `files` field;
Flowpad entities are referenced (not uploaded) via `asset_references` with their TypeIds.

```bash
curl -s --max-time 15 -X POST "$BASE/graph/conversation/<CONV_ID>/add_message" \
  -F 'message=<short intro text for the recipient>' \
  -F "files=@/abs/path/to/doc.md" \
  # repeat -F "files=@..." per extra file
  # entity reference instead of a file:  -F 'asset_references=markdown-<uuid>'
```

Expect `{"status": "SUCCESS"}`. `"Cloud login required to send messages"` → back to Step 2.
The attachment bundle (`body.flowmsg`) is built and uploaded to the hub in a background task —
no extra call needed.

## Step 4 — verify (always)

The success response does not carry the new message id. Read it off the conversation, then
confirm the attachment and upload state:

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
print('body_status:', d.get('body_status'))
print([(a.get('attachment_type'), a.get('data')) for a in d.get('attachment') or []])
"
```

Done when: `body_status` is `ready` and the `attachment` list contains a
`('file', 'data/<your-filename>')` entry. Report the message id and that the recipient can
download it. If `body_status` stays `uploading` for long, report that honestly — do not mark
the send verified.

## Error map

| Symptom | Meaning | Do |
| --- | --- | --- |
| `Cloud login required to send messages` | backend not cloud-logged-in (e.g. after restart) | Step 2: ask user to sign in, then retry |
| `Conversation not found: <id>` | wrong id / wrong instance | re-run Step 1; confirm `FLOW_INSTANCE` |
| connection refused on `$BASE` | backend down | tell the user; do not start servers yourself |
| `message, prompt, files, or asset_references required` | empty send | provide `message` and/or `files` |
