---
id: aea85f45-9bef-4ce2-ae2a-d593c36e1e92
title: Private context folders
version: 2
---

# Private context folders

A **private context folder** is a [[Context folders|context folder]] that stays
on this machine. It holds whatever you want an agent to see but nobody else to
get: private documents, skills, agents, reference material — the same kinds of
assets as any other folder, kept to yourself.

Private is the default, and it's about **sharing, not capability**. A private
folder is fully live locally: agent sessions in the project get access to it,
Flowpad indexes it, and any skills or agents inside it are discoverable exactly
as they would be in a [[Shared context folders|shared]] one. The only difference
is that it never leaves.

## What "never leaves" means

Nothing about a private folder is published — not its contents, and not its
path. When you share the project, private folders are excluded from what goes
to the hub, so other members never learn the folder exists or where it lives on
your disk.

Private is per **machine**, not per account. Attaching a folder privately on
your laptop doesn't attach it on your desktop, even as the same user.

## Good to know

* **Private doesn't mean non-Git.** A private folder can sit inside a Git
  repository and still be private — Flowpad records its origin either way. The
  Git requirement applies only to [[Shared context folders|shared]] folders.

* **You can't convert by wishing.** Switching a folder to shared means giving it
  a location others can reach — see [[Shared context folders]].

* **Removing never deletes.** Detaching a context folder leaves the directory on
  disk untouched.
