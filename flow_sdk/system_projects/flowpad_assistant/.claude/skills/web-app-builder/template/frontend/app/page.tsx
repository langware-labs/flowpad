"use client";

// Bootstrap status board — verifies frontend/backend/Supabase wiring after
// setup. Replace this page with your real landing page once everything is
// green.

import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

type Status = "checking" | "ok" | "down";

function StatusCard({
  title,
  description,
  status,
  detail,
}: {
  title: string;
  description: string;
  status: Status;
  detail: string;
}) {
  const dot =
    status === "ok"
      ? "bg-emerald-500"
      : status === "down"
        ? "bg-red-500"
        : "bg-zinc-400 animate-pulse";
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className={`inline-block size-2.5 rounded-full ${dot}`} />
          {title}
        </CardTitle>
        <CardDescription>{description}</CardDescription>
      </CardHeader>
      <CardContent className="text-sm text-muted-foreground">{detail}</CardContent>
    </Card>
  );
}

export default function Home() {
  const [backend, setBackend] = useState<Status>("checking");
  const [backendDetail, setBackendDetail] = useState("…");
  const [nextApi, setNextApi] = useState<Status>("checking");
  const [nextApiDetail, setNextApiDetail] = useState("…");

  const supabaseConfigured = Boolean(
    process.env.NEXT_PUBLIC_SUPABASE_URL &&
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  );

  const check = useCallback(() => {
    setBackend("checking");
    setNextApi("checking");

    // FastAPI via the /api/* rewrite (next.config.ts)
    fetch("/api/health")
      .then((r) => r.json())
      .then((d) => {
        setBackend("ok");
        setBackendDetail(`GET /api/health → ${JSON.stringify(d)}`);
      })
      .catch(() => {
        setBackend("down");
        setBackendDetail(
          "Start it: cd backend && .venv/bin/uvicorn main:app --reload --port 8080",
        );
      });

    // Next.js route handler (app/api/hello/route.ts) — wins over the rewrite
    fetch("/api/hello")
      .then((r) => r.json())
      .then((d) => {
        setNextApi("ok");
        setNextApiDetail(`GET /api/hello → ${JSON.stringify(d)}`);
      })
      .catch(() => {
        setNextApi("down");
        setNextApiDetail("Route handler failed — check the dev server logs.");
      });
  }, []);

  useEffect(check, [check]);

  return (
    <main className="container mx-auto max-w-3xl p-8">
      <h1 className="text-3xl font-semibold tracking-tight">It works.</h1>
      <p className="mt-2 text-muted-foreground">
        Next.js 16 + FastAPI + Supabase template. This page is a live status
        board — replace it with your app.
      </p>

      <div className="mt-8 grid gap-4">
        <StatusCard
          title="Next.js frontend"
          description="App Router, Tailwind v4, shadcn/ui"
          status="ok"
          detail="You are looking at it."
        />
        <StatusCard
          title="Next.js route handlers"
          description="app/api/* — TypeScript endpoints"
          status={nextApi}
          detail={nextApiDetail}
        />
        <StatusCard
          title="FastAPI backend"
          description="/api/* proxied to localhost:8080"
          status={backend}
          detail={backendDetail}
        />
        <StatusCard
          title="Supabase"
          description="Postgres + Auth + Storage (local stack via `supabase start`)"
          status={supabaseConfigured ? "ok" : "down"}
          detail={
            supabaseConfigured
              ? `Configured: ${process.env.NEXT_PUBLIC_SUPABASE_URL}`
              : "Not configured — run `supabase start`, paste the anon key into frontend/.env.local, restart dev."
          }
        />
      </div>

      <Button className="mt-6" onClick={check}>
        Re-check
      </Button>
    </main>
  );
}
