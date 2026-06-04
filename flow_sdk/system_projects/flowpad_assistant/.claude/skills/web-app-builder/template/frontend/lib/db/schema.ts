import { boolean, pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";

// TypeScript mirror of the canonical SQL schema in supabase/migrations/.
// After changing a migration, update this mirror (or regenerate it from the
// live local DB with `npm run db:pull`).

export const todos = pgTable("todos", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  completed: boolean("completed").notNull().default(false),
  insertedAt: timestamp("inserted_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});
