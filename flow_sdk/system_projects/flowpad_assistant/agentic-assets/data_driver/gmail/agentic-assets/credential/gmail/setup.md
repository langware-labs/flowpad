Connect a Gmail mailbox over IMAP/SMTP with an address and an app password.
1. 2-Step Verification must be on (https://myaccount.google.com/security). Open https://myaccount.google.com/apppasswords, create an app password named "Flowpad", and copy the 16 characters (spaces do not matter).
2. Pipe both values, one per line, into `flow credentials set gmail --stdin`: `GMAIL_ADDRESS=<address>` and `GMAIL_APP_PASSWORD=<app password>`.
3. Confirm with `flow credentials check gmail`. Never print or repeat the password.
