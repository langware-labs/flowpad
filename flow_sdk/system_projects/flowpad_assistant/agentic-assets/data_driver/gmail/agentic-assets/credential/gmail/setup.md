Connect a Gmail mailbox over IMAP/SMTP — one of two ways: a Google sign-in, or an address with an app password.
1. Ask which way they want:
   - **Sign in with Google** — they connect Google in Flowpad (`flow connections connect google`) and consent to mail access; then record the way with `flow credentials set gmail google`. There is nothing to copy, not even the address: the mailbox is the Google account that signed in.
   - **App password** — 2-Step Verification must be on (https://myaccount.google.com/security). Open https://myaccount.google.com/apppasswords, create an app password named "Flowpad", and copy the 16 characters (spaces do not matter). Pipe both values, one per line, into `flow credentials set gmail --stdin`: `GMAIL_ADDRESS=<address>` and `GMAIL_APP_PASSWORD=<app password>` — storing them records the way.
2. Confirm with `flow credentials check gmail`. Never print or repeat the password.
