Google Cloud Secret Manager — vault `{name}`:
- Secrets live in Google Cloud project `{project}`, one per variable, named `{prefix}<VARIABLE>`.
- Reads use this computer's Google application default sign-in, not the person's own `gcloud` login. It stays open until someone closes it.
- "denied": that account lacks the Secret Accessor role on these secrets. Only the vault's owner can give it (`flow secrets grant {name} <email>`); tell the user, do not try another account.
- A publish adds a new version and never deletes an old one. Never create, edit or delete secrets with `gcloud` yourself.
