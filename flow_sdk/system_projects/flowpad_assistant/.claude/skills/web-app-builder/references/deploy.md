# Deploying — Vercel + Supabase + Claude Code CI

The template deploys without restructuring: frontend → Vercel, database/auth →
hosted Supabase, FastAPI backend → any container host (Dockerfile included).
Do these in order; each step's output feeds the next one's env vars.

## 1. Hosted Supabase project

```bash
supabase login
supabase link --project-ref <project-ref>   # from app.supabase.com
supabase db push                            # applies supabase/migrations/*.sql
```

Collect from the project's dashboard (Settings → API / Database):

- Project URL → `NEXT_PUBLIC_SUPABASE_URL`
- anon/publishable key → `NEXT_PUBLIC_SUPABASE_ANON_KEY`
- Connection string (use the **pooler** URI for serverless) → `DATABASE_URL`

## 2. Backend (FastAPI)

`backend/Dockerfile` runs on any container platform (Fly.io, Railway, Render,
Cloud Run):

```bash
# example: Fly.io
cd backend && fly launch --now
```

Set `DATABASE_URL` in the host's env if the backend needs the DB. Note the
public URL — it becomes `BACKEND_URL`. If the app has no Python-specific
endpoints yet, you can skip this step and leave `BACKEND_URL` unset; Next.js
route handlers keep working.

## 3. Frontend (Vercel)

```bash
npm i -g vercel
cd frontend && vercel
```

Or connect the Git repo in the Vercel dashboard. Either way set
**Root Directory = `frontend`** and these env vars:

| Var                             | Value                            |
|---------------------------------|----------------------------------|
| `NEXT_PUBLIC_SUPABASE_URL`      | hosted project URL               |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | hosted anon key                  |
| `DATABASE_URL`                  | pooler connection string         |
| `BACKEND_URL`                   | deployed FastAPI URL (if step 2) |

The `/api/*` rewrite in `next.config.ts` reads `BACKEND_URL`, so the deployed
frontend transparently proxies to the deployed backend — client code is
unchanged between local and prod.

When using the Supabase **transaction pooler**, Drizzle's client is already
configured with `prepare: false` (required); nothing to change.

## 4. Claude Code GitHub Action

The template ships `.github/workflows/claude.yml`. Activate it:

1. Push the repo to GitHub.
2. Add a repo secret `ANTHROPIC_API_KEY` (Settings → Secrets → Actions).

Then mention `@claude` in any issue or PR comment to have Claude implement
changes, fix bugs, or review code; it answers with commits/PRs. The workflow
triggers on issue comments, PR review comments, new issues, and PR reviews
that contain `@claude`.

## Schema changes after the first deploy

Same loop as local: add a migration under `supabase/migrations/`, verify with
`supabase db reset` locally, then `supabase db push` to apply it to the hosted
project. Never edit the hosted schema through the dashboard — it diverges from
the migration history.
