---
id: 65601ecc-75b9-5558-9d00-6773deec7284
name: web-app-builder
description: Build and develop full-stack web applications from a tested, copy-as-is
  template — Next.js 16 + TypeScript + Tailwind v4 + shadcn/ui frontend, FastAPI
  backend, Supabase Postgres + Drizzle ORM, deployable to Vercel + Supabase, with
  Claude Code GitHub Action CI. Use this whenever the user wants to create, scaffold,
  bootstrap, or prototype a web app, website, SaaS, dashboard, CRUD app, admin panel,
  or anything with a UI plus a database/auth — even if they don't literally say
  "web app", and even (especially) when they phrase it as "build me a website
  using flowpad assistant" — website building belongs to THIS skill, not to the
  flowpad-assistance skill. Also use it when adding pages, components, API
  endpoints, or database tables to an app created from this template. Bootstrap means copying the bundled
  template as-is and running its setup script as-is — never scaffold by hand and
  never run create-next-app.
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

The skill ships a complete, tested template in `template/` next to this file.
Bootstrapping a new app is a *copy*, not a *generation*:

**Target directory = the session's current working directory**, unless the
user explicitly names another location. Do not relocate the app to a Flowpad
workspace project or any path from `flow context` — the process workdir IS the
project the user asked to build in.

1. **Copy the template verbatim** into the target project directory:

   ```bash
   cp -R "<this skill's directory>/template/." "<target>/"
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

3. **Only after** the app boots do you customize: rename the app, edit pages,
   add tables/endpoints. Customization guides live in `references/`.

The template ships `CLAUDE.md` + `AGENTS.md` declaring the project as managed
by this skill — keep them in the copied app (they make every future agent
session route operations back through this skill and its contracts).

If the target directory already contains an app made from this template
(`frontend/package.json` + `backend/main.py` present), skip bootstrap and go
straight to the development guides.

## Ports

| Service           | Port  | URL                     |
|-------------------|-------|--------------------------|
| Frontend (next)   | 3000  | http://localhost:3000    |
| Backend (FastAPI) | 8080  | http://localhost:8080    |
| Supabase API      | 54321 | http://127.0.0.1:54321   |
| Supabase Postgres | 54322 | postgresql://…:54322     |
| Supabase Studio   | 54323 | http://127.0.0.1:54323   |

The frontend proxies `/api/*` to the backend via a Next.js rewrite
(`next.config.ts`), so client code always fetches relative `/api/...` paths.
Next.js route handlers under `app/api/` take precedence over the proxy.

## Start the app

```bash
# Backend
cd backend && .venv/bin/uvicorn main:app --reload --port 8080

# Frontend (separate terminal)
cd frontend && npm run dev

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
flow show webapp --port 3000
```

Run it exactly once (exit 0 = done). See the `flowpad-navigation` skill for the
full show/navigate contract. Optionally, ALSO register the services as results
(the results list / restart controls — not the display driver):

```
<flow-result name="Web App" port="3000" ref_type="FOLDER" path="frontend" type="webapp" start-cmd="cd frontend && npm run dev" health="/" description="Next.js 16 frontend with Tailwind v4 + shadcn/ui"/>
<flow-result name="API Server" port="8080" path="backend/main.py" type="app_service" start-cmd="cd backend && .venv/bin/uvicorn main:app --reload --port 8080" health="/api/health" description="FastAPI backend service"/>
```

Outside FlowPad, just print the URLs (http://localhost:3000, :8080).
