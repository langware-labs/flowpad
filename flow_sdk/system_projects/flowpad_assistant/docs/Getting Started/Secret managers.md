---
id: e3b0e177-7de9-4060-b245-88fe205bb9a1
title: Secret managers
---

# Secret managers

**A credential's values reach a teammate only through the project's secret manager.** The credential itself — which keys the project needs, and where each one lives — travels with the project, by Git or a share. The values never go into Git or a message.

The project names its secret manager once, in its project manifest: **GCP Secret Manager** (a Google Cloud project; uses your Google sign-in) or **1Password** (a vault; uses the 1Password CLI, `op`, signed in on your computer).

- **Sharing a credential** when the project has no secret manager asks you to set one up first. Your local value is copied into it.
- **Opening a shared credential** shows where its values come from. **Fetch** copies them into your own `.env.local` (kept out of Git). Project setup fetches them too, before asking you for anything.
- **No access yet?** **Request access** asks the owner. Access is given to the project's secrets as a whole, in the secret manager itself.
- **No secret manager on the project?** **Report** sends it to the project's people through the usual help channel.

From the command line: `flow credentials publish <name>` puts your values in, `flow credentials fetch <name>` takes them out. Both print names only.
