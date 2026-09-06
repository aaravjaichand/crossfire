import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Reuse one connection pool across hot reloads in `next dev`.
const globalForDb = globalThis as unknown as { __crossfireSql?: postgres.Sql };

// prepare: false is what lets the same URL work against a direct Postgres
// connection, Supabase's session pooler, and its transaction pooler. PgBouncer
// in transaction mode hands every statement to whichever backend is free, so a
// named prepared statement created on one connection is not there on the next.
export const sql =
  globalForDb.__crossfireSql ?? postgres(url, { max: 5, prepare: false });
if (process.env.NODE_ENV !== "production") globalForDb.__crossfireSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
