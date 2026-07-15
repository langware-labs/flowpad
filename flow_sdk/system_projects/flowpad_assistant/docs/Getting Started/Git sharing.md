---
id: 1a1fdc0e-1e5d-5933-8ad0-c78679069e18
title: Git sharing
---

# Git sharing

When you share an asset into a conversation, Flowpad normally **copies** it — the
asset's bytes ride inside the message, and the recipient installs that copy.

**Git sharing** is a different way to share an asset that lives inside a Git
repository. Instead of copying bytes, Flowpad shares the asset's **Git origin** —
the repository, branch, and its path inside the repo. The recipient then clones or
pulls that repository to get the asset.

Turn it on with the **Git** toggle in the Share dialog. The choice is remembered
**per conversation**, so once it's on, later shares and replies in that
conversation use Git sharing too — until someone turns it off.

## When can I use it?

The Git toggle is only available when the asset:

- is file-backed (lives on disk),
- is inside a Git repository that has an `origin` remote you both can reach,
- is on a named branch (not a detached `HEAD`), and
- has **no uncommitted changes** and **no unpushed commits**.

If any of these aren't met, the toggle explains why. Commit and push your work,
then try again — Git sharing only travels what's on the remote.

## What the recipient sees

A Git-shared asset arrives as a chip with a **Download** button. Nothing is
cloned or pulled automatically — Git operations only happen when the recipient
clicks Download. Downloading:

1. clones the repository (or pulls it, if they already have a matching checkout),
2. checks out the shared branch, and
3. indexes the asset so it becomes a normal, live entity.

There is no separate install step — Git-shared assets are **not** copied and do
not offer "Install in project" or "Install global". Where the asset lives is
determined by the repository checkout, not an install choice.

If the asset's type needs setup (for example, an app that must be built or run),
a separate optional **Set up** / **Run** action appears after Download. Setup
never runs automatically.

## Good to know

- **It's not continuous sync.** A Git share reflects the branch's state at
  download time — the recipient sees at least what you shared, and possibly newer
  commits if the remote moved on. Flowpad does not keep pulling afterwards.
- **Failures are visible and retryable.** If a clone or pull fails — an
  unreachable remote, an authentication problem, or a dirty local checkout — the
  chip shows the reason and you can click Download again once it's resolved.
  Flowpad never indexes stale files in place of a failed pull.
- **Authentication is yours.** Cloning a private repository uses the recipient's
  own Git credentials, just like cloning it by hand.
