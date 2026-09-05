import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";

const url = process.env.DATABASE_URL;
if (!url) {
  throw new Error("DATABASE_URL is not set. Copy .env.example to .env.local.");
}

// Reuse one connection pool across hot reloads in `next dev`.
const globalForDb = globalThis as unknown as { __crossfireSql?: postgres.Sql };

export const sql = globalForDb.__crossfireSql ?? postgres(url, { max: 5 });
if (process.env.NODE_ENV !== "production") globalForDb.__crossfireSql = sql;

export const db = drizzle(sql, { schema });
export { schema };
