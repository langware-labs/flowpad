---
id: 5186c1d1-2ef4-4a27-83b2-33c202f6858b
title: Dependencies
version: 3
---

# Dependencies

A **dependency** is a folder your project expects to have in its context — a
company handbook, a library you're calling, a sibling repository, another
project that holds an agent you want to use here. Agents in the project can
read it, Flowpad indexes it, and its agents, skills and docs show up in this
project as if they were its own, while they still live, and are edited, in
their own folder.

A [[Flowpad project]] lists its dependencies in one file at its root,
`flow.json`, shaped like a `package.json`:

```json
{
  "dependencies": {
    "langware-os": "git+https://github.com/langware-labs/langware-os#main"
  },
  "optionalDependencies": {
    "policies": "hub:8c1f0b2e-…",
    "notes": "file:~/notes"
  }
}
```

Because the file is part of the project, it travels with it: everyone who gets
the project gets the same list.

## Where a dependency comes from

* **A Git repository** — `git+<url>#<branch>`. If you already have a checkout
  of it, Flowpad uses that one, wherever it is; otherwise it clones it into
  your Flowpad workspace. Add `"path"` to use one folder inside the repository.
* **A hub project** — `hub:<project id>`. Flowpad fetches the project's files
  with your hub login.
* **A folder on this computer** — `file:<path>`. Only for a folder that isn't
  in a Git repository: it exists on your machine only.

You rarely type these. **Add dependency** offers four tiles — another
**Project**, a **Folder on this computer**, a **Git repository** and a
**Hub project** — and writes the right line for you. A folder that is inside a
Git repository is always written as its repository, never as its path, so the
line means the same thing on a teammate's computer.

## Required or optional

* **Required** (`dependencies`) — fetched by itself when you open the project.
  If one can't be brought here — you're not logged in, you have no access, the
  folder is missing — Flowpad tells you when the project opens. You can choose
  **Don't show again until Flowpad restarts**; **Fix…** opens the project setup.
* **Optional** (`optionalDependencies`) — never fetched on its own. The
  project page lists it, so you can see what the project could use, with an
  **Install** button.

## Dependencies of dependencies

A dependency can have a `flow.json` of its own, and its required dependencies
come along too. Three rules keep that safe: its optional dependencies are left
to you, its `file:` folders are never used (a repository you received must not
point your agents at folders on your disk), and a dependency that leads back to
your project is simply skipped.

## Agents from a dependency

An agent that lives in a dependency appears on your project's home. Opening it
runs it **in your project** — its working folder is your project — while its
own folder stays in its context, and it is told where that folder is, so the
instructions it was written with still work.

## Sharing

Git and hub dependencies resolve on every member's computer. A required
`file:` dependency doesn't, so sharing a project that has one warns you who
would be missing it.

## Good to know

* **Removing never deletes.** Removing a dependency takes it out of
  `flow.json` and out of the project's context; the folder stays on disk.
* **Your own checkouts are never pulled.** Flowpad only updates the clones it
  made itself, and only when you sync with update.
* **From the terminal:** `flow dep list`, `flow dep add <folder | url | hub:id>`,
  `flow dep remove <name>`, `flow dep sync`, `flow dep install <name>`.

See also: [[Help desks]], [[Flowpad project]].
