# Agent instructions

> **This web app is managed by the FlowPad Assistant.**
> It was bootstrapped from the `web-app-builder` skill's template, and that
> skill remains the operating manual. **For ANY operation on this project —
> adding pages, components, or API endpoints, changing the database schema,
> running or restarting the servers, deploying — invoke the `web-app-builder`
> skill first** and follow its references. They encode the project's
> contracts; ad-hoc approaches drift from them.

## Stack (fixed by design — don't swap pieces)

Next.js 16 (App Router, TypeScript) · Tailwind v4 + shadcn/ui · FastAPI ·
Supabase Postgres · Drizzle ORM · deploys to Vercel + Supabase · Claude Code
GitHub Action (`@claude`).

## Setup

One-time, from the project root, **run as-is**:

```bash
python3 setup.py
```

## Run

```bash
cd backend  && .venv/bin/uvicorn main:app --reload --port 8080
cd frontend && npm run dev          # http://localhost:3000
supabase start                      # optional local DB (Docker)
```

## Contracts to preserve

- Ports: frontend 3000, backend 8080, Supabase 54321/54322/54323.
- Browser code fetches relative `/api/*` only; the Next rewrite routes to
  FastAPI, and `app/api/` route handlers take precedence. Never hardcode
  `localhost:8080` in frontend code.
- SQL migrations in `supabase/migrations/` are the canonical schema;
  `frontend/lib/db/schema.ts` is the typed mirror — keep them in sync.
- New tables get RLS enabled in their creation migration.
- `frontend/lib/db` (Drizzle, bypasses RLS) is server-only.
