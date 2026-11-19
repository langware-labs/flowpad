Google Cloud Secret Manager — vault `{name}`:
- Secrets live in Google Cloud project `{project}`, one per variable, named `{prefix}<VARIABLE>`.
- Reads use the account signed in to `gcloud` on this computer. "needs a sign-in": hand the user `! flow secrets setup {name}`; do not retry in a loop.
- "denied": that account lacks the Secret Accessor role on these secrets. Only the vault's owner can give it (`flow secrets grant {name} <email>`); tell the user, do not try another account.
- A publish adds a new version and never deletes an old one. Never create, edit or delete secrets with `gcloud` yourself.
