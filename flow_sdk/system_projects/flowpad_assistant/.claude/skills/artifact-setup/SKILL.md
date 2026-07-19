---
name: artifact-setup
description: Set up a RECEIVED artifact so it runs and shows live in the FlowPad Vibe
  display. Use this when a shared artifact has just been installed and needs to be
  made to work — clone/serve/build it as appropriate for its kind (a webapp folder,
  a static prototype, or a Claude Design handoff bundle) and surface the running app
  in the Vibe preview. This skill is invoked automatically by the reception flow with
  a prompt like "Use the artifact-setup skill to set up artifact-ID"; it is the
  setup counterpart of web-app-builder (which SCAFFOLDS new apps) — this one takes an
  existing received artifact and gets it running.
allowed-tools:
- Bash
- Read
- Glob
- Grep
---

# Artifact Setup

You are setting up a **received artifact** — one a teammate shared and the user just
installed — so it runs and renders live in the FlowPad **Vibe display**. You will be
told which artifact by its TypeId (e.g. `artifact-<uuid>`).

Your one job: **get the app running and shown in Vibe, with the least work that
produces a working site.** Do not rebuild an app that already runs.

## 1. Locate (or clone) the artifact's folder

The Artifact carries a provider-neutral `origin` pointer. Two cases:

- **Copy-shared** (the common case): the folder was copied into this project on install —
  `origin.kind` is `local`; the folder is `<origin.base>/<origin.rel_path>`. Find it:

  ```bash
  flow app discover          # lists webapp candidates under the project (name, path, kind, port)
  ```

  Pick the candidate matching the Artifact's name/origin. If discovery finds nothing, look
  for the folder yourself (`index.html` or `package.json` under the project tree).

- **Git-backed** (`origin.kind` is `git`): reuse a matching local checkout when one exists;
  otherwise clone the repo into the project, then use the checkout as the app folder. Read
  `origin` (`provider`/`owner`/`name`/`branch`/`rel_path`), `git clone` the branch into
  the project root, and set the app folder to `<checkout>/<rel_path>`. If cloning needs
  credentials you don't have, stop and report exactly what's needed — don't guess.

## 2. Dispatch on kind — then serve + show

`flow app open` does the heavy lifting: it discovers the app, installs deps only when
needed, starts the dev server detached, and **registers a local Deployment linked to the
Artifact with `show:True` so it lands in the Vibe display**. Runtime port/start/health
belong to that Deployment, never to the Artifact. Prefer it:

```bash
flow app open "<artifact name>" --root "<artifact folder>"
```

- **Framework app** (`package.json` with a `dev`/`start` script — Next.js, Vite, CRA):
  `flow app open` runs the install (`npm ci`/`npm install`) and `npm run dev`, waits for
  the port, and shows it. If `node` is missing from PATH, prepend nvm's bin dir
  (`export PATH="$HOME/.nvm/versions/node/*/bin:$PATH"`) and retry — the worker shell
  does not inherit nvm.

- **Static site / design prototype** (an `index.html`, no `package.json` — e.g. a
  Claude Design handoff that loads React + `@babel/standalone` from a CDN and transpiles
  its `.jsx` in the browser): it renders as-is when served. `flow app open` serves it
  with `python3 -m http.server`. If discovery misses it, do it explicitly:

  ```bash
  cd "<artifact folder>" && python3 -m http.server 8000 &   # background
  flow show webapp --port 8000                              # renders it in the Vibe display (run ONCE)
  ```

## 3. Confirm it shows

`flow show webapp --port <p>` (or `flow app open`'s `show:True`) pushes the running app
onto this process's display stack — the Vibe preview then renders it. Run the show
driver **exactly once** (exit 0 = done). Report the URL you served.

## Claude Design handoff bundles

A handoff bundle (a `README.md` that says "handoff bundle" + a `chats/` folder + an
`index.html` prototype) is a design deliverable whose prototype **already runs** in the
browser. The fast, reliable path is to **serve the prototype** (step 2, static) so the
user sees the working site immediately. Rebuilding it into a production app is a larger,
optional follow-up — see [references/upgrade.md](references/upgrade.md); do that only
when the user explicitly asks to "build it for real."
