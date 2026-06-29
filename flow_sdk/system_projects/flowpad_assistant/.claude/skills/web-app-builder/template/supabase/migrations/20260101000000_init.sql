-- Initial schema. Canonical source of truth — mirror any change into
-- frontend/lib/db/schema.ts (or regenerate it with `npm run db:pull`).

create table if not exists public.todos (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  completed boolean not null default false,
  inserted_at timestamptz not null default now()
);

-- RLS on from day one: without policies a table is inaccessible through the
-- Supabase (PostgREST) client; the direct DATABASE_URL connection used by
-- server code bypasses RLS.
alter table public.todos enable row level security;

create policy "todos are readable by everyone"
  on public.todos for select
  using (true);
