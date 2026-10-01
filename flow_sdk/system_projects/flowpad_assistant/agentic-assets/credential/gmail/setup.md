Connect a Gmail mailbox over IMAP/SMTP with an app password.
1. Ask the person which Gmail address to use; 2-Step Verification must be on for it (https://myaccount.google.com/security).
2. Open https://myaccount.google.com/apppasswords, create an app password named "Flowpad", and copy the 16 characters (spaces do not matter).
3. Store both: pipe the lines `GMAIL_ADDRESS=<address>` and `GMAIL_APP_PASSWORD=<app password>` into `flow credentials set gmail --stdin`.
4. Confirm with `flow credentials check gmail`. Never print or repeat the password.
