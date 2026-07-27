---
id: 5186c1d1-2ef4-4a27-83b2-33c202f6858b
title: Context folders
version: 2
---

# Context folders

A **context folder** is a directory elsewhere on your disk that you attach to a
project so agents can see it. A [[Flowpad project]] is one working folder;
context folders are how you give it more — a library you're calling, a sibling
service, a folder of reference material.

Attaching one does two things: agent sessions started in the project get access
to that directory as well as the project folder, and Flowpad indexes it, so its
assets become searchable and any skills or agents in it become discoverable.

The folder can live anywhere on disk — it does not need to be inside the
project.

## The three sources

* **Project folder** — pick another Flowpad project and attach its folder.

* **Open folder** — browse for any directory with the native folder picker.

* **Git folder** — set up a Git repository as a context folder, cloning an
  existing one or creating a new one. See [[Git context folders]].

## Private or shared

Pick the scope before you add the folder:

* **[[Private context folders|Private]]** — only on this machine. Never shared;
  neither its contents nor its path leave your computer.

* **[[Shared context folders|Shared]]** — belongs to the project, so everyone
  it's shared with gets it too.

Scope changes who gets the folder, not what it can do — a private folder is just
as live locally as a shared one.

**Flowpad shares the location, not the folder.** A shared folder travels as its
**origin** — a pointer to where the contents really live — and the recipient
fetches from there. Today that location must be a Git repository, so a plain
local folder can't be shared: Flowpad will tell you to add it as private
instead, or to use a folder inside a repository.

A folder counts as Git-backed when it's inside a repository that has an
`origin` remote Flowpad can read. Without an origin it's treated as local. Git-
backed folders show a git icon, a pill counting uncommitted changes, and a
**Push** button when you have unpushed commits.

## Good to know

* **Removing never deletes.** Detaching a context folder leaves the directory
  on disk untouched.

* **You need an active project.** The folder tiles are disabled without one.
