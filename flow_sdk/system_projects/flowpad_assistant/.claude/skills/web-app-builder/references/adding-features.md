# Adding features

## Adding a page

Next.js App Router: a folder under `frontend/app/` with a `page.tsx`.

```
frontend/app/
├── page.tsx              # /
├── dashboard/
│   └── page.tsx          # /dashboard
└── projects/
    └── [id]/
        └── page.tsx      # /projects/:id
```

Default to **server components** (no `"use client"`): they can query the DB
directly via Drizzle and ship less JS. Add `"use client"` only where you need
state, effects, or event handlers — and keep that boundary as low in the tree
as possible (a small interactive island inside a server page beats a fully
client page).

```tsx
// frontend/app/dashboard/page.tsx — server component, direct DB access
import { db } from "@/lib/db";
import { todos } from "@/lib/db/schema";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";

export default async function DashboardPage() {
  const items = await db.select().from(todos);
  return (
    <main className="container mx-auto p-6">
      <h1 className="mb-4 text-2xl font-semibold">Dashboard</h1>
      <Card>
        <CardHeader><CardTitle>Todos</CardTitle></CardHeader>
        <CardContent>{items.length} items</CardContent>
      </Card>
    </main>
  );
}
```

Links between pages: `import Link from "next/link"`.

## Adding a UI component

The template ships `button` and `card`. Add more shadcn/ui components with the
CLI (the template includes `components.json`, so it lands in the right place):

```bash
cd frontend && npx shadcn@latest add dialog table select form
```

Components arrive in `frontend/components/ui/` as editable source — restyle
them freely. Compose app-level components in `frontend/components/` and use
the `cn` helper from `@/lib/utils` for conditional classes.

## Adding an API endpoint — Next route handler vs FastAPI

Both are reachable from the browser under `/api/*` (route handlers win;
everything else is rewritten to FastAPI on `BACKEND_URL`, i.e. :<be-port>).

Pick **Next.js route handler** (`frontend/app/api/<name>/route.ts`) when the
endpoint is thin web glue: session/auth-coupled reads, form submissions,
webhooks, anything that mainly wraps a Drizzle/Supabase query.

```ts
// frontend/app/api/todos/route.ts
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { todos } from "@/lib/db/schema";

export async function GET() {
  return NextResponse.json(await db.select().from(todos));
}
```

Pick **FastAPI** (`backend/main.py`) when the work is Python's strength:
data/ML, heavy computation, Python-only SDKs, long-running jobs.

```python
class EchoRequest(BaseModel):
    text: str

@app.post("/api/echo")
async def echo(req: EchoRequest) -> dict:
    return {"echo": req.text}
```

FastAPI hot-reloads (`--reload`) and self-documents at
http://localhost:<be-port>/docs.

## Calling APIs from the client

Always relative paths — the rewrite handles routing in dev and prod:

```ts
const res = await fetch("/api/health");
const data = await res.json();
```

Never hardcode `localhost:<be-port>` in frontend code; that breaks the deployed
app (the rewrite destination comes from `BACKEND_URL`).
