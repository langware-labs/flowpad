---
id: 65601ecc-75b9-5558-9d00-6773deec7284
name: web-app-builder
# NOTE: folded block scalar (>-), not a plain scalar. A bare "word: word" inside
# a plain multi-line scalar is a YAML syntax error, and when the frontmatter
# fails to parse the loader falls back to the H1 title — the skill then appears
# in the agent's list with NO description and is never routed to.
description: >-
  Builds and extends web applications from two tested, copy-as-is templates: a
  Flowpad-SDK static app for anything working with Flowpad's own entities (tasks,
  docs, projects, agents, conversations), and a Next.js + FastAPI + Supabase stack
  for apps that own their data. Use whenever the user wants to create, scaffold,
  bootstrap or prototype a web app, website, SaaS, dashboard, CRUD app or admin
  panel — even when phrased as "build me a website using flowpad assistant" — or to
  add pages, components, API endpoints or database tables to an app already built
  from a template. Come here when the app needs a dev server, a build, a database
  or auth. NOT for a single static page with no build step (html-builder), slide
  decks (decker), or creating records (flowpad-assistance).
tags:
- webapp
- nextjs
- fastapi
- supabase
- drizzle
- fullstack
allowed-tools:
- Bash
- Read
- Write
- Edit
- Glob
- Grep
---

# Web App Builder

## FIRST: which template? (decide before writing anything)

Two templates ship with this skill. Pick by **whose data the app manages** — not
by how the request is phrased.

| The app works with… | Template | Stack |
|---|---|---|
| **Flowpad's own data** — tasks, docs, projects, agents, conversations | **`template-flowpad/`** | static HTML/JS + the Flowpad TS SDK |
| **Its own** data — needs a database, auth, signups, or a Vercel deploy | `template/` | Next.js + FastAPI + Supabase |

Decide with one question: **would the user expect what they create in this app
to show up in Flowpad?**

- "a task manager", "a kanban for my tasks", "a dashboard of my projects",
  "something to browse my docs" → **`template-flowpad/`**. These are views onto
  data Flowpad already owns. Building them on Supabase creates a second,
  disconnected copy of the user's tasks — the app looks right and is useless.
- "a SaaS with user signups", "a landing page with a waitlist", "a booking site
  for my customers" → `template/`. The data is the app's own and belongs in its
  own database.

If it is genuinely ambiguous, ask. Read `template-flowpad/README.md` before
building a Flowpad app; the rest of this file is about `template/`.

---

Build full-stack web applications using the 2026 default stack:

| Layer    | Choice                                      |
|----------|---------------------------------------------|
| Frontend | Next.js 16 (App Router) + React + TypeScript |
| UI       | Tailwind CSS v4 + shadcn/ui                  |
| Backend  | FastAPI (Python)                             |
| Database | Supabase Postgres (local stack via CLI)      |
| ORM      | Drizzle (TypeScript)                         |
| Deploy   | Vercel (frontend) + Supabase (DB/auth)       |
| CI / AI  | Claude Code GitHub Action (`@claude`)        |

Everything runs **local-first** (no cloud account needed to develop) and deploys
to Vercel + Supabase without restructuring.

## Bootstrap — copy as-is, run as-is (non-negotiable)

> **This section is the `template/` (Supabase) path.** If you chose
> `template-flowpad/` above, stop here and follow
> `template-flowpad/README.md` instead — it has its own, much shorter
> bootstrap (`cp -R`, edit three files, `flow app serve`). Everything below
> about Supabase, Drizzle, and the setup script does not apply to it.

The skill ships a complete, tested template in `template/` next to this file.
Bootstrapping a new app is a *copy*, not a *generation*:

**Target directory = `<project root>/assets/apps/<app name>`**, where
`<project root>` is the session's current working directory and `<app name>` is
a short kebab-case name derived from what the user asked to build (or the name
they provided). The user may explicitly name another location, which overrides
this default. Do not relocate the app to a Flowpad workspace project or any path
from `flow context` — the process workdir IS the project the user asked to build
in; the app nests under `assets/apps/` within it, and multiple apps can coexist
there. In this skill's `references/` guides and the template's own docs,
"project root" and relative paths like `cd frontend` mean the app directory
(`assets/apps/<app name>`), not the enclosing project.

If `<project root>/assets/apps/<app name>` already contains an app made from
this template (`frontend/package.json` + `backend/main.py` present), skip
bootstrap and go straight to the development guides.

1. **Copy the template verbatim** into the target app directory:

   ```bash
   cp -R "<this skill's directory>/template/." "<project root>/assets/apps/<app name>/"
   ```

   Do NOT scaffold by hand, do NOT run `create-next-app`, `npx shadcn init`, or
   any other generator, and do NOT "improve" template files before the first
   run. The template is a known-good, internally consistent unit (ports, env
   names, proxy rewrites, Drizzle ↔ SQL schema mirroring all agree with each
   other and with the docs in `references/`). Hand-rolled scaffolds drift and
   break those agreements.

2. **Run the setup script exactly as shipped**, from the target directory:

   ```bash
   python3 setup.py
   ```

   It installs npm + Python dependencies, creates the backend virtualenv, and
   materializes env files from `.env.example`. Run it as-is — don't replay its
   steps manually and don't edit it first. If a step fails, read its output and
   fix the environment (missing node, docker down, …), then re-run; it is
   idempotent.

3. **Update the enclosing project's documentation** — if `README.md`,
   `CLAUDE.md`, or `AGENTS.md` exist at `<project root>`, add a brief note
   recording that the web app is at `assets/apps/<app name>`, built from the
   web-app-builder template, plus the start commands from "Start the app" below
   prefixed with the app path (`cd assets/apps/<app name>/backend && …`). If a
   note for a previous app is already present, extend it rather than adding a
   duplicate. Never create these root files; only edit existing ones. The
   template's own `CLAUDE.md` and `AGENTS.md` in the app directory are separate
   and unchanged.

4. **Only after** the app boots do you customize: rename the app, edit pages,
   add tables/endpoints. Customization guides live in `references/`.

The template ships `CLAUDE.md` + `AGENTS.md` declaring the project as managed
by this skill — keep them in the copied app (they make every future agent
session route operations back through this skill and its contracts).

## Ports

| Service           | Port        | URL                             |
|-------------------|-------------|----------------------------------|
| Frontend (next)   | `<fe-port>` | http://localhost:`<fe-port>`     |
| Backend (FastAPI) | `<be-port>` | http://localhost:`<be-port>`     |
| Supabase API      | 54321 | http://127.0.0.1:54321   |
| Supabase Postgres | 54322 | postgresql://…:54322     |
| Supabase Studio   | 54323 | http://127.0.0.1:54323   |

**Never assume a port** — other builds are serving on this machine, and the
template's `npm run dev` hard-pins `--port 3000`, which fails with
`EADDRINUSE` when another build owns it. Ask for each port right before you
bind it, in this order: `<be-port>` from `flow app free-dev-port --bare`,
start the backend on it, THEN `<fe-port>` from `flow app free-dev-port --bare`
again (the backend now holds the first one, so you get a different port) and
start the frontend with `npx next dev --port <fe-port>` instead of
`npm run dev`. Set `BACKEND_URL=http://localhost:<be-port>` in
`frontend/.env.local` so the rewrite follows the backend. `flow show webapp`
gets the port `next dev` printed as `Local:` — never an assumed one.

The frontend proxies `/api/*` to the backend via a Next.js rewrite
(`next.config.ts`), so client code always fetches relative `/api/...` paths.
Next.js route handlers under `app/api/` take precedence over the proxy.

## Start the app

```bash
# Backend — on a port the picker hands you
BE_PORT=$(flow app free-dev-port --bare)
cd backend && .venv/bin/uvicorn main:app --reload --port $BE_PORT
# …then BACKEND_URL=http://localhost:$BE_PORT in frontend/.env.local

# Frontend (separate terminal) — pick again once the backend is up
FE_PORT=$(flow app free-dev-port --bare)
cd frontend && npx next dev --port $FE_PORT     # not `npm run dev` (pins 3000)

# Database (optional for pure-UI work; needs Docker)
supabase start
```

The landing page (`/`) is a live status board: it shows whether the FastAPI
backend, the Next route handlers, and Supabase are reachable — use it to verify
the bootstrap worked.

## Development guides

Read the matching reference before making that kind of change:

- **Local dev loop, env vars, Supabase local stack, troubleshooting** →
  [references/local-dev.md](references/local-dev.md)
- **Database: schema changes, migrations, Drizzle, RLS** →
  [references/database.md](references/database.md)
- **Adding pages, shadcn components, API endpoints (Next vs FastAPI)** →
  [references/adding-features.md](references/adding-features.md)
- **Deploying to Vercel + Supabase, Claude Code GitHub Action** →
  [references/deploy.md](references/deploy.md)

## IMPORTANT: show the running app to the user

When running inside FlowPad, as soon as the frontend dev server is up, present
it — this is what renders the live preview in the FlowPad display:

```bash
flow show webapp --port <fe-port>     # the port `next dev` printed, never an assumed one
```

Run it exactly once (exit 0 = done). See the `flowpad-navigation` skill for the
full show/navigate contract. Optionally, ALSO register the services as results
(the results list / restart controls — not the display driver):

```
<flow-result name="Web App" port="<fe-port>" ref_type="FOLDER" path="frontend" type="webapp" start-cmd="cd frontend && npm run dev" health="/" description="Next.js 16 frontend with Tailwind v4 + shadcn/ui"/>
<flow-result name="API Server" port="<be-port>" path="backend/main.py" type="app_service" start-cmd="cd backend && .venv/bin/uvicorn main:app --reload --port <be-port>" health="/api/health" description="FastAPI backend service"/>
```

Outside FlowPad, just print the URLs (http://localhost:<fe-port>, :<be-port>).

## Testing the app — use the `web-tester` skill

When the user asks to **test / QA / validate / smoke-test / check** the app in a
browser, don't hand-roll Playwright here — route to the **web-tester** skill. With
the dev server running, it sweeps the app's routes headlessly (console/JS errors,
failed requests, screenshots, broken links, basic a11y) and reports pass/fail,
keeping all debug artifacts in an isolated temp folder (never in this project).
