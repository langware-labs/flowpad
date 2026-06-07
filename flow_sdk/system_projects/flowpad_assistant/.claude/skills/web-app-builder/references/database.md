# Database: Supabase Postgres + Drizzle

Two layers, one schema:

- **SQL migrations in `supabase/migrations/` are canonical.** They are what
  `supabase db reset` applies locally and what `supabase db push` applies to
  the hosted project on deploy. RLS policies live here too.
- **`frontend/lib/db/schema.ts` (Drizzle) mirrors that schema** to give
  TypeScript code typed queries. It does not own the schema.

Keeping one canonical owner (SQL migrations) means local dev, CI, and the
hosted Supabase project all converge from the same files, and Postgres-only
concepts (RLS, triggers, extensions) don't have to squeeze through an ORM.

## Making a schema change

1. Write a new migration:

   ```bash
   supabase migration new add_projects_table
   # creates supabase/migrations/<timestamp>_add_projects_table.sql — edit it
   ```

   ```sql
   create table if not exists public.projects (
     id uuid primary key default gen_random_uuid(),
     name text not null,
     inserted_at timestamptz not null default now()
   );

   alter table public.projects enable row level security;
   create policy "read for all" on public.projects for select using (true);
   ```

2. Apply locally:

   ```bash
   supabase db reset      # clean replay of all migrations
   ```

3. Mirror it in `frontend/lib/db/schema.ts`:

   ```ts
   export const projects = pgTable("projects", {
     id: uuid("id").primaryKey().defaultRandom(),
     name: text("name").notNull(),
     insertedAt: timestamp("inserted_at", { withTimezone: true }).notNull().defaultNow(),
   });
   ```

   For larger changes you can regenerate the mirror from the live local DB
   instead of writing it by hand: `npm run db:pull` (drizzle-kit introspect).

## Querying

**From Next.js server code** (server components, route handlers, server
actions) use Drizzle via `lib/db`:

```ts
import { db } from "@/lib/db";
import { todos } from "@/lib/db/schema";

const open = await db.select().from(todos).where(eq(todos.completed, false));
```

**From the browser** use the Supabase client (`lib/supabase/client.ts`) — it
goes through PostgREST and respects RLS with the user's auth token:

```ts
const supabase = createClient();
const { data } = await supabase.from("todos").select("*");
```

**From FastAPI** read `DATABASE_URL` from the environment and use any Postgres
driver (`psycopg`); add it to `backend/requirements.txt` when first needed.

Rule of thumb: trusted server-side logic → Drizzle (full SQL power, bypasses
RLS via the direct connection); browser/user-scoped data → Supabase client
(RLS enforced).

## RLS

Every table in the template has RLS enabled from its creation migration.
Keep that invariant for new tables: `alter table … enable row level security`
plus explicit policies. A table without policies is inaccessible through the
Supabase client (good default) but fully accessible through `DATABASE_URL`
(server-only).

## Useful commands

```bash
supabase db reset            # replay migrations into the local DB
supabase migration new NAME  # create an empty timestamped migration
npm run db:pull              # regenerate schema.ts from the local DB
npm run db:studio            # Drizzle Studio (alternative to Supabase Studio)
```

`npm run db:push` (schema-first push) exists for quick prototyping but skips
the migration files — anything you keep must end up as a migration before
deploy.
