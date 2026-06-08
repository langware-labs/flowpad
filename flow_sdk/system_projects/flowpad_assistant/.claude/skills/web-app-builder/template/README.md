# Web App

Full-stack app: **Next.js 16** (TypeScript, Tailwind v4, shadcn/ui) +
**FastAPI** + **Supabase Postgres** (Drizzle ORM). Local-first; deploys to
Vercel + Supabase.

## Quickstart

```bash
python3 setup.py                 # installs everything, creates env files

# terminal 1
cd backend && .venv/bin/uvicorn main:app --reload --port 8080

# terminal 2
cd frontend && npm run dev       # http://localhost:3000

# database (optional, needs Docker + supabase CLI)
supabase start                   # paste printed anon key into frontend/.env.local
supabase db reset                # apply supabase/migrations/
```

The landing page at http://localhost:3000 shows live status for all three
services.

## Layout

```
frontend/   Next.js 16 app — UI, route handlers, Drizzle queries
backend/    FastAPI — Python endpoints under /api/* (proxied via Next rewrite)
supabase/   canonical SQL migrations + local-stack config
.github/    Claude Code action — mention @claude in issues/PRs
AGENTS.md   agent instructions — this app is managed via the FlowPad
            Assistant web-app-builder skill (CLAUDE.md points here)
```

## Ports

| Frontend | Backend | Supabase API | Postgres | Studio |
|----------|---------|--------------|----------|--------|
| 3000     | 8080    | 54321        | 54322    | 54323  |

## Deploy

Frontend → Vercel (root dir `frontend`), DB → hosted Supabase
(`supabase link && supabase db push`), backend → any container host
(`backend/Dockerfile`). Set `BACKEND_URL` on Vercel to the deployed backend.
Add an `ANTHROPIC_API_KEY` repo secret to activate the `@claude` GitHub
workflow.
