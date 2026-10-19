---
id: abb779e1-ca3c-4717-9344-59422ee06389
---
# Gmail source

Set these in `.env.local` first:

```dotenv
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
```

Then create a source of the shipped Gmail driver:

```python
import os
from flow_sdk.builtin.data_driver import DataDriver

address = os.environ["GMAIL_ADDRESS"]

driver = await DataDriver.get("gmail")
gmail = driver.create_source(
    driver.create_config(address=address),
    name="gmail",
    account_key=address,
    account_identities=[address],
    poll_interval_seconds=60,
)
await gmail.save()
```

The app password is read from `GMAIL_APP_PASSWORD` when Gmail is contacted. It
is never copied into the DataSource row or its metadata — which is exactly what
`tests/unit/test_gmail_snippet.py` runs this page to check.

For a report sender that already has a Google `gmail.send` grant, use
`flow_sdk.sources.gmail_send` instead of creating an IMAP mailbox source.
`compose_message` accepts the sender, To/Cc recipients, plain text, HTML and
`InlineImage` values with matching HTML CID references. `raw_message` exposes
the Gmail API body for inspection without sending. `send_message` uses the
existing source HTTP client and requires `approved=True` after the caller's
recipient confirmation. It sends once and returns Gmail's message-id response.

The caller retains OAuth refresh, account selection, consent scopes and dry-run
policy. This helper never widens scopes, reads mail, or substitutes a Flowpad
message. MIME and confirmation behavior have offline tests; a live send still
requires an explicitly approved recipient before claiming provider parity.
