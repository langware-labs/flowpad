# Gmail source

Set these in `.env.local` first:

```dotenv
GMAIL_ADDRESS=you@gmail.com
GMAIL_APP_PASSWORD=abcdefghijklmnop
```

Then create the official Gmail `DataSource`:

```python
import os
import flow_sdk.ingest.drivers  # noqa: F401 — register shipped drivers
from flow_sdk.builtin.data_source import DataSource

address = os.environ["GMAIL_ADDRESS"]

gmail = DataSource(
    name="gmail",
    provider="gmail",
    config={"address": address},
    account_key=address,
    account_identities=[address],
    poll_interval_seconds=60,
)
await gmail.save()
```

The app password is read from `GMAIL_APP_PASSWORD` when Gmail is contacted. It
is never copied into the DataSource row or its metadata — which is exactly what
`tests/unit/test_gmail_snippet.py` runs this page to check.
