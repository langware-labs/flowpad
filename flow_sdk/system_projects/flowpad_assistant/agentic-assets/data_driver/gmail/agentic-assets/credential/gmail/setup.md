Connect a Gmail mailbox over IMAP/SMTP — one of two ways: a Google sign-in, or an app password.
1. Ask the person which Gmail address to use, and store it: pipe `GMAIL_ADDRESS=<address>` into `flow credentials set gmail --stdin`.
2. Ask which way they want:
   - **Sign in with Google** — they connect Google in Flowpad (`flow connections connect google`) and consent to mail access; then record the way with `flow credentials set gmail GMAIL_GOOGLE`. There is nothing to copy.
   - **App password** — 2-Step Verification must be on (https://myaccount.google.com/security). Open https://myaccount.google.com/apppasswords, create an app password named "Flowpad", and copy the 16 characters (spaces do not matter). Pipe `GMAIL_APP_PASSWORD=<app password>` into `flow credentials set gmail --stdin` — storing it records the way.
3. Confirm with `flow credentials check gmail`. Never print or repeat the password.
