---
id: e3b0e177-7de9-4060-b245-88fe205bb9a1
title: Secret managers
---

# Secret managers

**A credential's values reach a teammate only through the project's secret manager.** The credential itself — which keys the project needs, and where each one lives — travels with the project, by Git or a share. The values never go into Git or a message.

The project names its secret manager once, in its project manifest: **GCP Secret Manager** (a Google Cloud project; uses your Google sign-in) or **1Password** (a vault; uses the 1Password CLI, `op`, signed in on your computer).

- **Sharing a credential** when the project has no secret manager asks you to set one up first. Your local value is copied into it.
- **Opening a shared credential** shows where its values come from. **Fetch** copies them into your own `.env.local` (kept out of Git). Project setup fetches them too, before asking you for anything.
- **Secret manager not set up on this computer?** **Set up** runs its setup wizard: installs the manager's command line, signs you in, and checks the vault — then fetches. From a terminal: `flow secrets setup <vault>`.
- **No access yet?** **Request access** asks the owner. Access is given to the project's secrets as a whole, in the secret manager itself.
- **No secret manager on the project?** **Report** sends it to the project's people through the usual help channel.

**The key icon in the footer** shows the secret manager in use: the project's default vault, or your global one when the project has none. Click a vault's name to open it, **Make default** to choose which one the project uses, and **Global → Set** for a vault of your own on this computer. An agent that needs a secret it does not have reads it from that vault, and saves nothing unless you say so.

From the command line: `flow secrets publish <name> --vault <vault>` puts your values in, `flow secrets fetch <name>` takes them out. Both print names only.
