---
id: dba086ad-cec4-4a9b-921d-3a313a0570e9
title: Git context folders
---

# Git context folders

A **Git context folder** is a [[Context folders|context folder]] backed by a Git
repository. It's the option to reach for when the folder needs to be **shared**
— sharing a context folder travels over Git, so a shared folder has to be a
repository with an `origin` remote.

Picking the **Git folder** tile opens a small form with two choices: use an
**existing repository**, by URL, or create a **new repository**, by name. Once
you submit, a wizard agent does the setup on your machine and reports back as
it goes.

## Existing repository

Flowpad checks the URL first, then puts the repository in your Flowpad
workspace folder. If you already have a checkout of that repository there, it
reuses it and pulls rather than cloning a second copy. Then it registers the
repository as its own Flowpad project and attaches it to your current project
as a context folder.

## New repository

Flowpad creates the repository in your Flowpad workspace folder, makes an
initial commit, and then sets up the remote. If you have the `gh` CLI installed
and authenticated, it creates the GitHub repository for you and pushes — and
the repository is **public**: anyone can read it, only you can write. If `gh`
isn't available, it asks you for an empty remote URL to push to instead.

## Good to know

- **It isn't done until there's an `origin` remote.** Flowpad decides a folder
  is Git-backed by its origin. Without one it degrades to a plain local folder:
  no git icon, and Push fails.
- **The wizard stays open.** It tells you when the setup is finished but won't
  close itself — click **Done** when you're satisfied, or reply to ask for
  changes first (a different name, a different remote).
- **An existing folder can be converted.** If a folder is already attached and
  you want to share it, Flowpad can initialize a repository in place rather
  than moving it.
