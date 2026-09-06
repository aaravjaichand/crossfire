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
//
// max must stay above the widest fan-out a single render issues (the home page
// fires eight queries in one Promise.all); postgres.js pipelines the overflow
// onto a busy connection, which a transaction pooler cannot multiplex, so the
// page would hang instead of erroring. idle_timeout hands connections back so
// serverless instances do not exhaust the pooler's client limit between hits.
export const sql =
  globalForDb.__crossfireSql ??
  postgres(url, { max: 10, prepare: false, idle_timeout: 10, connect_timeout: 15 });
if (process.env.NODE_ENV !== "production") globalForDb.__crossfireSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
