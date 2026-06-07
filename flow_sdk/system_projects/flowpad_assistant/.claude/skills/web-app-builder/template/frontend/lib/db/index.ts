import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";

import * as schema from "./schema";

// Server-only Drizzle client over the direct Postgres connection
// (DATABASE_URL). Bypasses RLS — never import from client components.
// `prepare: false` is required for the Supabase transaction pooler.
const client = postgres(process.env.DATABASE_URL!, { prepare: false });

export const db = drizzle(client, { schema });
