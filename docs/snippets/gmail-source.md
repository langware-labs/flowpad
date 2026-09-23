---
id: 8304a216-d418-4307-a48f-e735c8027de7
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
